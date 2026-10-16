import type { RunCostSummary } from "./cost-types";

/**
 * success: exit 0. partial: exit 2. failed: any other exit code, or the precondition failed.
 * timeout: killed at the job's `timeout`. deferred (2026-10-16): the job's `precondition`
 * exited 75, no command or Claude session ran, the slot is retried after `retry_after`.
 * blocked: the command exited with a code the job lists under `outcome_codes.blocked`
 * (waiting on a person; no retry). killed: the process ended without an exit code (the
 * daemon stopped, SIGKILL), recorded as failed with exit=None until 2026-10-16.
 */
export type RunStatus =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "timeout"
  | "deferred"
  | "blocked"
  | "killed";
export type TriggerType = "scheduled" | "manual" | "catchup";
/** scheduler.yaml `catchup`: which missed slots get a catch-up run. Unset means "always". */
export type CatchupPolicy = "always" | "same-day" | "never";
/**
 * scheduler.yaml `priority`: "background" (the default) runs the job's process tree under
 * `taskpolicy -c background` on macOS (`nice -n 19` elsewhere), so it yields CPU and I/O to
 * interactive sessions and runs at full speed only on an idle machine. "normal" opts a job out.
 */
export type JobPriority = "background" | "normal";

export interface JobConfig {
  name: string;
  schedule: string;
  directory: string;
  type: "claude" | "script";
  prompt?: string;
  command?: string;
  enabled: boolean;
  model?: string;
  timeout?: number;
  max_retries?: number;
  catchup?: CatchupPolicy;
  priority?: JobPriority;
  skip_permissions?: boolean;
  tags: string[];
  /** Role name(s) from `hosts`, or "all". Required once `hosts` is declared. */
  runs_on?: string | string[];
  /**
   * Shell command run in the job's directory before the job is spawned, with the job's env.
   * Exit 0 runs the job; exit 75 (EX_TEMPFAIL) records the run as `deferred` without starting
   * the command or Claude session; anything else records `failed` with the output in output.log.
   */
  precondition?: string;
  /** Seconds the precondition may take before it counts as failed. Default 60. */
  precondition_timeout?: number;
  /** Seconds after a deferred run before the slot is retried (at most 2 retries). Default 600. */
  retry_after?: number;
  /** Exit codes with a meaning of their own: `blocked` = waiting on a person. */
  outcome_codes?: { blocked?: number[] };
  /**
   * A script job that starts a Claude session itself (autopilot's `claude -p`). Held with the
   * claude-type jobs while the account's usage window is exhausted (see UsageHold). Default false.
   */
  uses_claude?: boolean;
}

/**
 * The account's usage limit, as a run's output reported it (usage-limit.ts): the 7-day
 * ("weekly") or 5-hour ("session") window, the reset instant when the text named one the
 * parser understood, the zone in the text, and the line itself.
 */
export interface UsageLimitHit {
  kind: "weekly" | "session";
  resetsAt: string | null;
  zone: string | null;
  text: string;
}

/**
 * The hold the daemon keeps after a run hit the usage limit (data/usage-hold.json): no job that
 * starts a Claude session (claude-type, or script with `uses_claude`) starts before `until`.
 * Skipped ticks are counted, logged once each, and queued as catch-ups under the job's policy.
 */
export interface UsageHold {
  version: 1;
  kind: UsageLimitHit["kind"];
  /** ISO instant the hold ends: the reset plus a minute, or 30 min after the hit when unknown. */
  until: string;
  /** ISO instant the hold started (the run that hit the limit finished). */
  since: string;
  /** The limit line, verbatim. */
  text: string;
  /** Ticks of held jobs skipped so far. */
  skipped: number;
  jobId: string | null;
  runId: string | null;
}

/** Deferred runs: retries per slot and the delay before each (see RunStatus). */
export const DEFERRED_RETRY = { maxRetries: 2, retryAfterSec: 600 } as const;
export const PRECONDITION_TIMEOUT_SEC = 60;

/** The machine a daemon resolved from `hosts` at config load (see config-schema.ts). */
export interface HostInfo {
  name: string;
  role: string;
}

export interface SchedulerDefaults {
  timeout: number;
  max_retries: number;
  retain_runs: number;
  /** Default `priority` for jobs that set none. Unset behaves as "background". */
  priority?: JobPriority;
}

/**
 * How the post-run evaluator uses the Jev decision model (TypeSafe System One).
 * off: Haiku only. shadow: Haiku decides, Jev is recorded beside it. enforce: Jev decides,
 * Haiku only writes the prose summary for warning/critical/follow-up runs.
 */
export type DecisionMode = "off" | "shadow" | "enforce" | "benchmark";

export interface EvaluatorConfig {
  decision_model: DecisionMode;
  /** Months of data/evaluations/YYYY-MM.jsonl to keep (default 12). */
  log_retain_months?: number;
}

/**
 * One line of data/evaluations/YYYY-MM.jsonl: everything needed to study a run after its
 * run directory has been pruned. Written once per evaluated run, whatever the decision mode.
 */
export interface EvaluationLogRecord {
  version: 1;
  ts: string;
  jobId: string;
  runId: string;
  jobName: string;
  trigger: TriggerType;
  catchupFor?: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Execution attempts recorded for the run (1 = no retry). */
  attempts: number;
  executionCostUsd: number | null;
  executionModels: string[];
  evaluation: {
    source: RunEvaluation["source"] | null;
    severity: EvalSeverity | null;
    followUpNeeded: boolean | null;
    haikuCostUsd: number | null;
    haikuModel: string | null;
    /** Present when Haiku gave an enforce-mode second opinion (see RunEvaluation.secondOpinion). */
    secondOpinion?: RunEvaluation["secondOpinion"];
    /** Present on benchmark-mode runs: Haiku's independent verdict (see RunEvaluation.haikuBenchmark). */
    haikuBenchmark?: RunEvaluation["haikuBenchmark"];
  };
  decision: {
    mode: DecisionMode;
    state: "off" | "pending" | "complete" | "unavailable";
    model: string | null;
    severity: EvalSeverity | null;
    severityProbabilities: Record<EvalSeverity, number> | null;
    severityConfidence: number | null;
    followUpProbability: number | null;
    failureKind: string | null;
    failureKindConfidence: number | null;
    latencyMs: number | null;
    inputTokens: number | null;
    costUsd: number | null;
    error: string | null;
  };
  /** Haiku verdict vs Jev verdict when both judged the same run (shadow or benchmark mode); null otherwise. */
  agreement: { severity: boolean | null; followUp: boolean | null };
}

export interface SchedulerConfig {
  version: number;
  defaults: SchedulerDefaults;
  evaluator?: EvaluatorConfig;
  /** Host name (the Mac's LocalHostName; see localHostName in daemon/config.ts) -> role, or { role, ssh }. Declared: every job needs runs_on. */
  hosts?: Record<string, string | { role: string; ssh?: string }>;
  /** Set by the loader when `hosts` is declared; `jobs` then holds only this role's jobs. */
  host?: HostInfo;
  jobs: Record<string, JobConfig>;
}

export interface RunMeta {
  jobId: string;
  runId: string;
  jobConfig: JobConfig;
  trigger: TriggerType;
  startedAt: string;
  catchupFor?: string;
  /** Host that ran it (its resolved host name, as in `hosts`); absent on runs from before 2026-10-15. */
  host?: string;
  /** The cron slot this run stands for (ISO); a deferred run's retry carries the same slot. */
  slot?: string;
  /** 1 or 2 when this run is a retry of a deferred run of the same slot. */
  deferredRetry?: number;
}

export interface RunStatusFile {
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** On a `blocked` run: why. `usage-limit` = the account's usage window is exhausted (2026-10-16). Absent for `outcome_codes.blocked` exits. */
  blockedReason?: "usage-limit";
  /** The limit line and its reset, when blockedReason is `usage-limit`. */
  usageLimit?: UsageLimitHit;
}

export interface DaemonHealth {
  status: "running" | "stopped";
  pid: number;
  port: number;
  startedAt: string;
  lastHeartbeat: string;
  activeJobs: string[];
  /** Present when scheduler.yaml declares `hosts`. */
  host?: HostInfo;
  /** True after POST /api/drain: no new runs start; the daemon exits once activeJobs is empty. */
  draining?: boolean;
  /** Present while the account's usage window is exhausted: Claude jobs are held until `until`. */
  usageHold?: UsageHold | null;
}

export type EvalSeverity = "ok" | "info" | "warning" | "critical";

export interface RunEvaluation {
  summary: string;
  severity: EvalSeverity;
  followUpNeeded: boolean;
  followUpReason: string | null;
  evaluatedAt: string;
  /**
   * Who produced severity/followUp: Haiku, Jev, Jev with a Claude-written summary ("jev+haiku":
   * Haiku for a warning/critical/follow-up summary, Sonnet for a second opinion in the uncertain
   * band since 2026-10-16; the model is in the ledger's haikuModel), or the scheduler itself for a
   * deferred run (no model call). Absent on older runs.
   */
  source?: "haiku" | "jev" | "jev+haiku" | "scheduler";
  /** Enforce mode: the second opinion (Sonnet since 2026-10-16) asked for when Jev's P(follow-up) was in the uncertain band. */
  secondOpinion?: { severity: EvalSeverity; followUpNeeded: boolean };
  /** Benchmark mode: Haiku's own verdict on the run, recorded beside Jev's as a comparison baseline. */
  haikuBenchmark?: { severity: EvalSeverity; followUpNeeded: boolean };
}

/** One Jev (System One) answer set for a run: typed decisions with probabilities, no prose. */
export interface RunDecision {
  model: string;
  requestId: string | null;
  provider: string | null;
  latencyMs: number;
  severity: {
    label: EvalSeverity;
    score: number;
    confidence: number;
    probabilities: Record<EvalSeverity, number>;
  };
  followUp: { probability: number; needed: boolean };
  failureKind: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  evaluatedAt: string;
}

/** data/runs/<job>/<run>/evaluation-decision.json */
export interface RunDecisionFile {
  version: 1;
  mode: Exclude<DecisionMode, "off">;
  state: "pending" | "complete" | "unavailable";
  decision: RunDecision | null;
  usage: import("./cost-types").DecisionUsage | null;
  error: string | null;
  updatedAt: string;
}

export interface RunStats {
  toolCalls: number;
  toolsByName: Record<string, number>;
  isAiSession: boolean;
  finalized?: boolean;
}

export interface ActivityDayBucket {
  date: string; // YYYY-MM-DD
  sessions: number;
  toolCalls: number;
}

export interface ActivityStatsResponse {
  lifetime: {
    sessions: number;
    toolCalls: number;
    toolsByName: Record<string, number>;
  };
  daily: ActivityDayBucket[];
  /** Per host when scheduler.yaml declares `hosts`; the top level is then their sum. */
  hosts?: HostActivityStats[];
}

export interface HostActivityStats {
  name: string;
  role: string;
  isSelf: boolean;
  lifetime: ActivityStatsResponse["lifetime"];
  daily: ActivityDayBucket[];
}

export interface RunSummary {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: RunStatus;
  trigger: TriggerType;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
  decision?: RunDecision;
  cost?: RunCostSummary;
  configuredModel?: string;
  catchupFor?: string;
  /** Host that ran it: from meta.json, or the host whose data holds it (see host-data.ts). */
  host?: string;
  /** Inner Claude sessions a script run started; their text is the run's session log. */
  innerSessions?: number;
}

export interface CatchupQueueEntry {
  jobId: string;
  jobName: string;
  missedSlot: string;
  enqueuedAt: string;
  /** "retry": the slot's run was deferred by its precondition and runs again at notBefore. */
  kind?: "catchup" | "retry";
  notBefore?: string;
  retry?: number;
}

export interface CatchupQueueInFlight {
  jobId: string;
  jobName: string;
  startedAt: string;
}

export interface CatchupQueueSnapshot {
  queued: CatchupQueueEntry[];
  inFlight: CatchupQueueInFlight | null;
}
