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

/** Usage of the Jev decision model for one run. costUsd is the provider-reported charge, or null when it was not reported. */
export interface DecisionUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  model: string | null;
}

export interface RunCostSummary {
  currency: "USD";
  totalCostUsd: number | null;
  executionCostUsd: number | null;
  evaluationCostUsd: number | null;
  /** Jev decision spend for this run; included in totalCostUsd when known. */
  decisionCostUsd: number | null;
  coverage: "complete" | "partial" | "unavailable";
  evaluationState: "pending" | "complete" | "unavailable";
  /** "off" when the run was evaluated without the decision model. */
  decisionState: "off" | "pending" | "complete" | "unavailable";
  attempts: AttemptCost[];
  evaluation: CostEntry | null;
  decision: DecisionUsage | null;
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
  /** Jev decision model usage, counted even for runs with no other cost reporting. */
  decisionRequests: number;
  decisionInputTokens: number;
  decisionCostUsd: number | null;
  /**
   * Estimated Haiku spend avoided by Jev, minus Jev spend. Shadow runs count the Haiku cost of
   * runs Jev judged clean (enforce would skip Haiku); enforce runs without a Haiku call count the
   * retained-history average Haiku evaluation cost. Negative when Jev only added overhead.
   */
  decisionSavingsUsd: number | null;
  /** Enforce-mode runs evaluated without any Haiku call. */
  decisionHaikuSkipped: number;
  /** Shadow and benchmark runs where both Haiku and Jev judged the run, and how often they agreed. */
  decisionCompared: number;
  decisionSeverityAgreed: number;
  decisionFollowUpAgreed: number;
}

export interface JobCostSummary extends CostTotals {
  jobId: string;
  jobName: string;
  /** Host that ran these runs, when scheduler.yaml declares `hosts` (a job may run on several). */
  host?: string;
}

/** One host's share of the cost stats; the response's top level is then the sum of all hosts. */
export interface HostCostStats {
  name: string;
  role: string;
  isSelf: boolean;
  today: CostTotals;
  month: CostTotals;
  retained: CostTotals;
  period: CostTotals;
  daily: CostDayBucket[];
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
  /** Every recorded run: retained run directories plus the preserved costs of pruned runs. */
  retained: CostTotals;
  period: CostTotals;
  daily: CostDayBucket[];
  jobs: JobCostSummary[];
  /** Average Haiku evaluation cost over retained history (including pruned runs' preserved costs) where Haiku produced the verdict; the savings baseline. */
  baselineHaikuEvaluationCostUsd: number | null;
  baselineHaikuEvaluations: number;
  /** Per host when scheduler.yaml declares `hosts`. */
  hosts?: HostCostStats[];
}
