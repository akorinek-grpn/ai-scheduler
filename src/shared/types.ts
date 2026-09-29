import type { RunCostSummary } from "./cost-types";

export type RunStatus = "running" | "success" | "partial" | "failed" | "timeout";
export type TriggerType = "scheduled" | "manual" | "catchup";
/** scheduler.yaml `catchup`: which missed slots get a catch-up run. Unset means "always". */
export type CatchupPolicy = "always" | "same-day" | "never";

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
  skip_permissions?: boolean;
  tags: string[];
}

export interface SchedulerDefaults {
  timeout: number;
  max_retries: number;
  retain_runs: number;
}

export interface SchedulerConfig {
  version: number;
  defaults: SchedulerDefaults;
  jobs: Record<string, JobConfig>;
}

export interface RunMeta {
  jobId: string;
  runId: string;
  jobConfig: JobConfig;
  trigger: TriggerType;
  startedAt: string;
  catchupFor?: string;
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
}

export type EvalSeverity = "ok" | "info" | "warning" | "critical";

export interface RunEvaluation {
  summary: string;
  severity: EvalSeverity;
  followUpNeeded: boolean;
  followUpReason: string | null;
  evaluatedAt: string;
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
  cost?: RunCostSummary;
  configuredModel?: string;
  catchupFor?: string;
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
