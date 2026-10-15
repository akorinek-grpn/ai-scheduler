import type { RunCostSummary } from "./cost-types";

export type RunStatus =
  "running" | "success" | "partial" | "failed" | "timeout";
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
}

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
}

export interface RunStatusFile {
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
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
}

export type EvalSeverity = "ok" | "info" | "warning" | "critical";

export interface RunEvaluation {
  summary: string;
  severity: EvalSeverity;
  followUpNeeded: boolean;
  followUpReason: string | null;
  evaluatedAt: string;
  /** Who produced severity/followUp: Haiku, Jev, or Jev with a Haiku-written summary. Absent on older runs. */
  source?: "haiku" | "jev" | "jev+haiku";
  /** Enforce mode: Haiku's own verdict, asked for when Jev's P(follow-up) was in the uncertain band. */
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
