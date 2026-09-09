import type { CostEntry, RunCostSummary } from "./cost-types";

export function getReportedModels(entries: CostEntry[]): string[] {
  const names = entries.flatMap((entry) => [entry.model, ...entry.models.map((usage) => usage.model)]);
  return [...new Set(names.filter((model): model is string => typeof model === "string" && model.trim().length > 0))].sort();
}

export function getExecutionModels(cost?: RunCostSummary): string[] {
  return getReportedModels(cost?.attempts.flatMap((attempt) => attempt.entries) ?? []);
}
