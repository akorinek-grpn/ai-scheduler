/**
 * Client for the Jev decision model (TypeSafe "System One"), used by the post-run evaluator.
 *
 * Jev does not generate text. It takes a `state` plus typed questions and returns, per question,
 * a typed answer with probabilities: a Score (ordered rubric), a Noul (P(yes)) or a Choice.
 * Endpoint: POST {TYPESAFE_BASE_URL}/v1/systemone. Through OpenRouter the base URL is
 * https://openrouter.ai/api and the model id is typesafe/jev-1.13; the response then also carries
 * `usage.cost` (USD), which is the only cost figure this module reports. Nothing is priced locally.
 */
import { z } from "zod";
import type { DecisionUsage } from "@shared/cost-types";
import type { EvalSeverity, RunDecision, RunStatus } from "@shared/types";

/**
 * P(follow-up) at or above this flags a follow-up. 0.6 since 2026-10-15: a replay of 303 retained
 * runs put every failed, timed-out or partial run at 0.63 or higher, while 0.50-0.59 held only
 * routine reports and repeated hand-back notices (scripts/jev-replay.ts).
 */
export const FOLLOW_UP_THRESHOLD = 0.6;
/** Longest `output_tail` sent as state. Jev's context is 32k tokens; the log tail stays well under it. */
export const MAX_STATE_CHARS = 48_000;
const TAIL_LINES = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const SEVERITY_LEVELS: readonly EvalSeverity[] = [
  "ok",
  "info",
  "warning",
  "critical",
];

/**
 * The three questions, kept together so thresholds and wording are reviewed in one place.
 * Severity levels mirror the Haiku evaluator prompt; the Score answer is read as the argmax level.
 * The stand-down and routine-report clauses date from 2026-10-15: a log review found the
 * disagreements with Haiku sat on runs that deferred on a lock, found nothing eligible, held a
 * gate or printed their routine report. A replay of 303 retained runs (scripts/jev-replay.ts)
 * moved those to P(follow-up) 0.10-0.22 and cut flagged successful runs from 17% to 4% at the
 * 0.6 threshold, while every failed, timed-out or partial run stayed at 0.78 or above; the
 * job_status clause in `true` is what keeps the hand-back failures (exit 30) up there.
 */
export const DECISION_QUESTIONS = {
  severity: {
    type: "score",
    instructions:
      "How severe is the outcome of this scheduled job run, judged from `job_status`, `exit_code` and `output_tail`? " +
      "Only this run's own outcome matters: error text quoted from reviewed code, from other runs, or from the job's instructions is not a problem of this run. " +
      "A run that stood down on purpose (another job held a lock, nothing was eligible or pending, a gate held) or that produced its routine report did what it was meant to do.",
    criteria: [
      "ok: completed successfully, no issues; a deliberate stand-down or a routine report is ok",
      "info: completed with minor notes worth knowing",
      "warning: completed but with issues to address soon (partial failures, degraded data, auth warnings, an unreachable host that was skipped)",
      "critical: failed, produced wrong results, or has errors needing immediate attention (auth expired, data corruption, missing outputs)",
    ],
  },
  follow_up_needed: {
    type: "noul",
    instructions:
      "Should a human look at this run before the next scheduled run? Only this run's own outcome counts.",
    criteria: {
      true: "a job_status of failed, timeout or partial; an auth/credential failure, a partial completion, an unexpected error, a missing expected output, a skipped host, or the output asks for human input",
      false: "the job did what it was meant to do, including standing down on purpose (a lock held by another job, nothing eligible or pending, a gate that held) or producing its routine report, and nothing needs a person",
    },
  },
  failure_kind: {
    type: "choice",
    instructions:
      "Which best describes the dominant problem in this run, if any?",
    criteria: {
      none: "no problem, or the run stood down on purpose",
      auth_expired: "login, token, credential or 401/403 problems",
      network: "unreachable host, DNS, TLS, socket or connection errors",
      timeout: "the run or a step hit a time limit",
      missing_output: "an expected file, report or artifact was not produced",
      data_error: "wrong, empty or corrupt data was produced or read",
      needs_human_input:
        "the output asks a person to decide or provide something",
      other: "a problem that fits none of the above",
    },
  },
} as const;

export interface DecisionInput {
  jobName: string;
  status: RunStatus;
  exitCode: number | null;
  output: string;
}

/** The shape of DECISION_QUESTIONS with plain strings, so alternative wording is assignable. */
export interface DecisionQuestions {
  severity: { type: "score"; instructions: string; criteria: readonly string[] };
  follow_up_needed: {
    type: "noul";
    instructions: string;
    criteria: { true: string; false: string };
  };
  failure_kind: {
    type: "choice";
    instructions: string;
    criteria: Readonly<Record<string, string>>;
  };
}

export interface DecisionClientOptions {
  /** null disables the call (reported as an error); undefined reads TYPESAFE_API_KEY. */
  apiKey?: string | null;
  /** Alternative questions, same shape as DECISION_QUESTIONS; scripts/jev-replay.ts measures wording changes with it. */
  questions?: DecisionQuestions;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface DecisionResult {
  decision: RunDecision | null;
  usage: DecisionUsage | null;
  error: string | null;
}

export interface DecisionEnv {
  apiKey: string | null;
  baseUrl: string;
  model: string;
}

/** Same variables the official TypeSafe SDKs read, so one env file serves both. */
export function decisionEnv(
  env: Record<string, string | undefined> = process.env,
): DecisionEnv {
  return {
    apiKey: env.TYPESAFE_API_KEY?.trim() || null,
    baseUrl: trimSlash(
      env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai",
    ),
    model: env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest",
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * MCP connector status notices that Claude jobs echo into their summaries ("the cognee and oncrawl
 * MCP servers failed to connect", "context7 needs OAuth authorization"). They describe the
 * session's environment, not the run's outcome, yet every PR run that carried one was rated "info"
 * (2026-10-05 audit of 22 enforce-mode PR runs). A sentence is a notice when it reports the
 * connection or authorization status of a connector no scheduled job uses, or is the generic
 * "MCP servers need authorization" boilerplate of a non-interactive session.
 * SHORTCUT: matched per sentence against a fixed list of idle connectors. A connector a job does
 * use (echelon-prod, a calendar) keeps its failure sentences, so Jev still sees them; when a job
 * starts using a listed connector, or another unused one starts failing, edit IDLE_CONNECTOR.
 */
const IDLE_CONNECTOR =
  /\b(?:cognee|oncrawl|context7)\b|claude\.ai connectors?/i;
const CONNECTOR_STATUS =
  /fail(?:ed|s|ing)? to connect|CONNECTION_CLOSED|authori[sz]|\bOAuth\b|`\/mcp`/i;
const MCP_AUTHORIZATION_BOILERPLATE =
  /\bMCP servers?\b[^.]*\bneed(?:s|ing)? (?:OAuth )?authori[sz]ation/i;
/** Splits after . ! ? when whitespace, a capital or markdown follows, so "claude.ai" and "1.2" stay whole. */
const SENTENCE_END = /(?<=[.!?])(?=\s|[A-Z*`])/;

const isConnectorNotice = (sentence: string): boolean =>
  (IDLE_CONNECTOR.test(sentence) && CONNECTOR_STATUS.test(sentence)) ||
  MCP_AUTHORIZATION_BOILERPLATE.test(sentence);

export function dropConnectorNotices(output: string): string {
  const kept: string[] = [];
  for (const line of output.split("\n")) {
    if (!IDLE_CONNECTOR.test(line) && !/\bMCP\b/.test(line)) {
      kept.push(line);
      continue;
    }
    const remaining = line
      .split(SENTENCE_END)
      .filter((sentence) => !isConnectorNotice(sentence))
      .join("");
    // A line that was only a notice (or its bullet) goes entirely; others keep their own text.
    if (remaining.replace(/^[\s*>-]*/, "").trim()) kept.push(remaining);
  }
  return kept.join("\n");
}

export function buildDecisionRequest(
  input: DecisionInput,
  model: string,
  questions: DecisionQuestions = DECISION_QUESTIONS,
) {
  const output = dropConnectorNotices(input.output);
  const lines = output.split("\n");
  let tail =
    lines.length > TAIL_LINES ? lines.slice(-TAIL_LINES).join("\n") : output;
  if (tail.length > MAX_STATE_CHARS) tail = tail.slice(-MAX_STATE_CHARS);
  return {
    model,
    state: {
      job_name: input.jobName,
      job_status: input.status,
      exit_code: input.exitCode,
      output_tail: tail,
    },
    questions,
  };
}

/** Argmax over the four levels; a tie goes to the more severe level, which is the safe direction. */
export function severityFromProbabilities(
  probabilities: Record<string, number>,
): EvalSeverity {
  let best: EvalSeverity = "ok";
  let bestValue = -1;
  SEVERITY_LEVELS.forEach((label, index) => {
    const value = probabilities[String(index)] ?? 0;
    if (value >= bestValue) {
      best = label;
      bestValue = value;
    }
  });
  return best;
}

const probabilitiesSchema = z.record(z.string(), z.number());
const responseSchema = z.object({
  id: z.string().optional(),
  provider: z.string().optional(),
  model: z.string(),
  answers: z.object({
    severity: z.object({
      type: z.literal("score"),
      score: z.number(),
      confidence: z.number(),
      probabilities: probabilitiesSchema,
    }),
    follow_up_needed: z.object({ type: z.literal("noul"), noul: z.number() }),
    failure_kind: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: z.number(),
      probabilities: probabilitiesSchema,
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().min(0).optional(),
  }),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One decision request with a single retry on rate limits, overload and transport errors. Never throws. */
export async function requestRunDecision(
  input: DecisionInput,
  options: DecisionClientOptions = {},
): Promise<DecisionResult> {
  const env = decisionEnv();
  const apiKey = options.apiKey === undefined ? env.apiKey : options.apiKey;
  const baseUrl = trimSlash(options.baseUrl ?? env.baseUrl);
  const model = options.model ?? env.model;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!apiKey)
    return {
      decision: null,
      usage: null,
      error: "TYPESAFE_API_KEY is not set",
    };

  const body = JSON.stringify(
    buildDecisionRequest(input, model, options.questions ?? DECISION_QUESTIONS),
  );
  let error = "decision request did not complete";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "ai-scheduler evaluator",
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        error = `HTTP ${response.status}: ${text.slice(0, 200)}`;
        if (RETRY_STATUSES.has(response.status)) continue;
        break;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        error = "response was not JSON";
        break;
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        error = `unexpected response shape at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`;
        break;
      }
      const { answers, usage } = parsed.data;
      const probabilities = Object.fromEntries(
        SEVERITY_LEVELS.map((label, index) => [
          label,
          answers.severity.probabilities[String(index)] ?? 0,
        ]),
      ) as Record<EvalSeverity, number>;
      return {
        decision: {
          model: parsed.data.model,
          requestId: parsed.data.id ?? null,
          provider: parsed.data.provider ?? null,
          latencyMs: Date.now() - startedAt,
          severity: {
            label: severityFromProbabilities(answers.severity.probabilities),
            score: answers.severity.score,
            confidence: answers.severity.confidence,
            probabilities,
          },
          followUp: {
            probability: answers.follow_up_needed.noul,
            needed: answers.follow_up_needed.noul >= FOLLOW_UP_THRESHOLD,
          },
          failureKind: {
            choice: answers.failure_kind.choice,
            confidence: answers.failure_kind.confidence,
            probabilities: answers.failure_kind.probabilities,
          },
          evaluatedAt: new Date().toISOString(),
        },
        usage: {
          requests: 1,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd: usage.cost ?? null,
          model: parsed.data.model,
        },
        error: null,
      };
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.name === "AbortError"
            ? `timed out after ${timeoutMs} ms`
            : failure.message
          : String(failure);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return { decision: null, usage: null, error };
}
