/**
 * Evaluation ledger: one JSON line per evaluated run in data/evaluations/YYYY-MM.jsonl.
 *
 * Run directories are pruned after `retain_runs` runs, so this is the only long-horizon record of
 * how jobs behave (status, duration, cost, catch-ups), what Haiku and Jev decided about each run,
 * and whether they agreed. Monthly files keep the footprint bounded: a record is roughly 1.5 KB,
 * so 60 runs a day is about 3 MB a month; `evaluator.log_retain_months` prunes older months.
 */
import fs from "node:fs";
import path from "node:path";
import { getEvaluationLogDir } from "@shared/paths";
import { getExecutionModels, getReportedModels } from "@shared/model-usage";
import type {
  EvaluationLogRecord,
  RunDecisionFile,
  RunSummary,
} from "@shared/types";

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;

export function getEvaluationLogPath(projectRoot: string, ts: string): string {
  return path.join(getEvaluationLogDir(projectRoot), `${ts.slice(0, 7)}.jsonl`);
}

export function buildEvaluationRecord(
  run: RunSummary,
  decisionFile: RunDecisionFile | null,
  ts = new Date().toISOString(),
): EvaluationLogRecord {
  const cost = run.cost;
  const usage = cost?.decision ?? null;
  const decision = decisionFile?.decision ?? null;
  const evaluation = run.evaluation ?? null;
  const haikuEntry = cost?.evaluation ?? null;
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  // Haiku's own verdict on the run: the evaluation itself when Haiku decided it (shadow, off, or a
  // fallback), or the verdict recorded beside Jev's in benchmark mode.
  const haikuVerdict =
    evaluation === null
      ? null
      : evaluation.source !== "jev" && evaluation.source !== "jev+haiku"
        ? evaluation
        : (evaluation.haikuBenchmark ?? null);
  return {
    version: 1,
    ts,
    jobId: run.jobId,
    runId: run.runId,
    jobName: run.jobName,
    trigger: run.trigger,
    ...(run.catchupFor ? { catchupFor: run.catchupFor } : {}),
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs:
      Number.isFinite(started) && Number.isFinite(finished)
        ? finished - started
        : null,
    attempts: cost?.attempts.length ?? 0,
    executionCostUsd: cost?.executionCostUsd ?? null,
    executionModels: getExecutionModels(cost),
    evaluation: {
      source: evaluation?.source ?? null,
      severity: evaluation?.severity ?? null,
      followUpNeeded: evaluation?.followUpNeeded ?? null,
      haikuCostUsd: haikuEntry?.costUsd ?? null,
      haikuModel: getReportedModels(haikuEntry ? [haikuEntry] : [])[0] ?? null,
      ...(evaluation?.secondOpinion
        ? { secondOpinion: evaluation.secondOpinion }
        : {}),
      ...(evaluation?.haikuBenchmark
        ? { haikuBenchmark: evaluation.haikuBenchmark }
        : {}),
    },
    decision: {
      mode: decisionFile?.mode ?? "off",
      state: decisionFile?.state ?? "off",
      model: usage?.model ?? decision?.model ?? null,
      severity: decision?.severity.label ?? null,
      severityProbabilities: decision?.severity.probabilities ?? null,
      severityConfidence: decision?.severity.confidence ?? null,
      followUpProbability: decision?.followUp.probability ?? null,
      failureKind: decision?.failureKind.choice ?? null,
      failureKindConfidence: decision?.failureKind.confidence ?? null,
      latencyMs: decision?.latencyMs ?? null,
      inputTokens: usage?.inputTokens ?? null,
      costUsd: usage?.costUsd ?? null,
      error: decisionFile?.error ?? null,
    },
    agreement: {
      severity:
        decision && haikuVerdict
          ? haikuVerdict.severity === decision.severity.label
          : null,
      followUp:
        decision && haikuVerdict
          ? haikuVerdict.followUpNeeded === decision.followUp.needed
          : null,
    },
  };
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function pruneOldMonths(
  directory: string,
  ts: string,
  retainMonths: number,
): void {
  const [year, month] = ts.slice(0, 7).split("-").map(Number);
  const cutoff = monthIndex(year, month) - (retainMonths - 1);
  for (const name of fs.readdirSync(directory)) {
    const match = MONTH_FILE.exec(name);
    if (!match) continue;
    if (monthIndex(Number(match[1]), Number(match[2])) < cutoff)
      fs.rmSync(path.join(directory, name), { force: true });
  }
}

/** Appends one record and drops month files beyond the retention window. Throws on I/O failure; callers decide. */
export function appendEvaluationRecord(
  projectRoot: string,
  record: EvaluationLogRecord,
  retainMonths = 12,
): void {
  const file = getEvaluationLogPath(projectRoot, record.ts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  pruneOldMonths(
    path.dirname(file),
    record.ts,
    Math.max(1, Math.floor(retainMonths)),
  );
}

/** Records from every retained month in time order; corrupt lines are skipped, not fatal. */
export function readEvaluationRecords(
  projectRoot: string,
  options: { since?: string } = {},
): EvaluationLogRecord[] {
  const directory = getEvaluationLogDir(projectRoot);
  let names: string[];
  try {
    names = fs
      .readdirSync(directory)
      .filter((name) => MONTH_FILE.test(name))
      .sort();
  } catch {
    return [];
  }
  const sinceMs = options.since
    ? Date.parse(options.since)
    : Number.NEGATIVE_INFINITY;
  const records: EvaluationLogRecord[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(directory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as EvaluationLogRecord;
        if (
          parsed?.version === 1 &&
          typeof parsed.ts === "string" &&
          Date.parse(parsed.ts) >= sinceMs
        )
          records.push(parsed);
      } catch {
        // skip corrupt line
      }
    }
  }
  return records.sort(
    (left, right) => Date.parse(left.ts) - Date.parse(right.ts),
  );
}
