import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getRunDir } from "@shared/paths";
import type { AttemptCost, CostEntry, EvaluationCostFile, ModelCost, RunCostFile, RunCostSummary, TokenUsage } from "@shared/cost-types";

const amountSchema = z.number().finite().nonnegative();
const tokensSchema = z.object({
  inputTokens: amountSchema.int(), outputTokens: amountSchema.int(),
  cacheReadTokens: amountSchema.int(), cacheWriteTokens: amountSchema.int(),
});
const entrySchema = z.object({
  id: z.string().min(1).max(256), label: z.string().min(1).max(256),
  source: z.enum(["claude", "script"]), costUsd: amountSchema,
  model: z.string().trim().min(1).max(256).optional(),
  tokens: tokensSchema.nullable(),
  models: z.array(tokensSchema.extend({ model: z.string(), costUsd: amountSchema.nullable() })),
});
const runCostSchema = z.object({
  version: z.literal(1), updatedAt: z.string(),
  attempts: z.array(z.object({ attempt: z.number().int().positive(), complete: z.boolean(), entries: z.array(entrySchema) })),
});
const evaluationCostSchema = z.object({
  version: z.literal(1), updatedAt: z.string(),
  state: z.enum(["pending", "complete", "unavailable"]), entry: entrySchema.nullable(),
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseTokens(value: unknown, camelCase = false): TokenUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const parsed = tokensSchema.safeParse({
    inputTokens: usage[camelCase ? "inputTokens" : "input_tokens"],
    outputTokens: usage[camelCase ? "outputTokens" : "output_tokens"],
    cacheReadTokens: usage[camelCase ? "cacheReadInputTokens" : "cache_read_input_tokens"] ?? 0,
    cacheWriteTokens: usage[camelCase ? "cacheCreationInputTokens" : "cache_creation_input_tokens"] ?? 0,
  });
  return parsed.success ? parsed.data : null;
}

export function sumCost(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.round(known.reduce((total, value) => total + value, 0) * 1e9) / 1e9 : null;
}

function sumTokens(values: Array<TokenUsage | null>): TokenUsage | null {
  const known = values.filter((value): value is TokenUsage => value !== null);
  if (!known.length) return null;
  return known.reduce((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

function claudeEntry(event: Record<string, unknown>): CostEntry | null {
  const costUsd = amount(event.total_cost_usd);
  if (costUsd === null || (event.subtype === "error_during_execution" && costUsd === 0)) return null;
  const modelUsage = record(event.modelUsage ?? event.model_usage);
  const models: ModelCost[] = [];
  for (const [model, raw] of Object.entries(modelUsage ?? {})) {
    const usage = record(raw);
    const tokens = parseTokens(raw, true);
    if (usage?.costBasis === "unknown") return null;
    if (tokens) models.push({ model, costUsd: amount(usage?.costUSD), ...tokens });
  }
  const wholeTreeTokens = models.length > 0 && models.length === Object.keys(modelUsage ?? {}).length;
  return {
    id: "claude", label: "Claude session", source: "claude", costUsd, models,
    tokens: wholeTreeTokens ? sumTokens(models) : parseTokens(event.usage),
  };
}

export class CostTracker {
  private readonly entries = new Map<string, CostEntry>();
  private complete = false;
  private invalidReport = false;

  constructor(private readonly source: "claude" | "script", private readonly attempt: number) {}

  consume(line: string): boolean {
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(line)); } catch { return false; }
    if (!event) return false;
    if (this.source === "claude") {
      if (event.type !== "result" || event.parent_tool_use_id) return false;
      const entry = claudeEntry(event);
      this.complete = entry !== null && event.subtype !== "error_during_execution";
      if (entry) this.entries.set(entry.id, entry);
      return true;
    }
    if (event.type === "scheduler_cost_complete") {
      this.complete = this.entries.size > 0 && !this.invalidReport;
      return true;
    }
    if (event.type !== "scheduler_cost") return false;
    this.complete = false;
    const parsed = entrySchema.safeParse({
      id: event.id, label: event.label ?? event.id, source: "script",
      costUsd: event.currency === "USD" ? event.cost_usd : null,
      model: event.model,
      tokens: parseTokens(event.usage), models: [],
    });
    if (parsed.success) this.entries.set(parsed.data.id, parsed.data);
    else this.invalidReport = true;
    return true;
  }

  snapshot(): AttemptCost {
    return { attempt: this.attempt, complete: this.complete, entries: [...this.entries.values()] };
  }
}

function writeCostFile(filePath: string, data: RunCostFile | EvaluationCostFile): void {
  const temporary = `${filePath}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    fs.renameSync(temporary, filePath);
  } catch (error) {
    console.warn(`[costs] Could not persist ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeRunCost(projectRoot: string, jobId: string, runId: string, attempts: AttemptCost[]): void {
  writeCostFile(path.join(getRunDir(projectRoot, jobId, runId), "costs.json"), {
    version: 1, attempts, updatedAt: new Date().toISOString(),
  });
}

export function writeEvaluationCost(
  projectRoot: string, jobId: string, runId: string,
  state: EvaluationCostFile["state"], entry: CostEntry | null = null,
): void {
  writeCostFile(path.join(getRunDir(projectRoot, jobId, runId), "evaluation-cost.json"), {
    version: 1, state, entry, updatedAt: new Date().toISOString(),
  });
}

function readCostFile<Output>(filePath: string, schema: z.ZodType<Output>): Output | null {
  try {
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readRunCost(projectRoot: string, jobId: string, runId: string): RunCostSummary {
  const directory = getRunDir(projectRoot, jobId, runId);
  const execution = readCostFile(path.join(directory, "costs.json"), runCostSchema);
  const evaluation = readCostFile(path.join(directory, "evaluation-cost.json"), evaluationCostSchema);
  const attempts = execution?.attempts ?? [];
  const entries = attempts.flatMap((attempt) => attempt.entries);
  const evaluationEntry = evaluation?.entry ?? null;
  const executionCostUsd = sumCost(entries.map((entry) => entry.costUsd));
  const evaluationCostUsd = evaluationEntry?.costUsd ?? null;
  const totalCostUsd = sumCost([executionCostUsd, evaluationCostUsd]);
  const executionComplete = attempts.length > 0 && attempts.every((attempt) => attempt.complete && attempt.entries.length > 0);
  const evaluationComplete = evaluation?.state === "complete" && evaluationEntry !== null;
  return {
    currency: "USD", totalCostUsd, executionCostUsd, evaluationCostUsd,
    coverage: totalCostUsd === null ? "unavailable" : executionComplete && evaluationComplete ? "complete" : "partial",
    evaluationState: evaluation?.state ?? "unavailable", attempts, evaluation: evaluationEntry,
    tokens: sumTokens([...entries.map((entry) => entry.tokens), evaluationEntry?.tokens ?? null]),
  };
}
