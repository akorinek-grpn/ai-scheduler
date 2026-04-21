export type RunStatus = "running" | "success" | "partial" | "failed" | "timeout";
export type TriggerType = "scheduled" | "manual";

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
}
