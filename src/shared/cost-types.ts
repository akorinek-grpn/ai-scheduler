export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelCost extends TokenUsage {
  model: string;
  costUsd: number | null;
}

export interface CostEntry {
  id: string;
  label: string;
  source: "claude" | "script";
  costUsd: number;
  tokens: TokenUsage | null;
  models: ModelCost[];
  model?: string;
}

export interface AttemptCost {
  attempt: number;
  complete: boolean;
  entries: CostEntry[];
}

export interface RunCostFile {
  version: 1;
  attempts: AttemptCost[];
  updatedAt: string;
}

export interface EvaluationCostFile {
  version: 1;
  state: "pending" | "complete" | "unavailable";
  entry: CostEntry | null;
  updatedAt: string;
}

export interface RunCostSummary {
  currency: "USD";
  totalCostUsd: number | null;
  executionCostUsd: number | null;
  evaluationCostUsd: number | null;
  coverage: "complete" | "partial" | "unavailable";
  evaluationState: "pending" | "complete" | "unavailable";
  attempts: AttemptCost[];
  evaluation: CostEntry | null;
  tokens: TokenUsage | null;
}

export interface CostTotals {
  totalCostUsd: number | null;
  executionCostUsd: number | null;
  evaluationCostUsd: number | null;
  runs: number;
  trackedRuns: number;
  completeRuns: number;
  averageCostUsd: number | null;
  executionModels?: string[];
}

export interface JobCostSummary extends CostTotals {
  jobId: string;
  jobName: string;
}

export interface CostDayBucket extends CostTotals {
  date: string;
}

export interface CostStatsResponse {
  currency: "USD";
  timezone: "UTC";
  days: number;
  today: CostTotals;
  month: CostTotals;
  retained: CostTotals;
  period: CostTotals;
  daily: CostDayBucket[];
  jobs: JobCostSummary[];
}
