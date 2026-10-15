import type {
  CostTotals,
  JobCostSummary,
  RunCostSummary,
} from "../../shared/cost-types";

export const COST_DISCLAIMER =
  "Reported estimates in USD (API-equivalent), not subscription invoices. Pruned runs keep their costs; runs pruned before costs were preserved count as not reporting. Cost dates are UTC.";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function formatCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0)
    return "Unavailable";
  if (value > 0 && value < 0.01) return "<$0.01";
  return usdFormatter.format(value);
}

/** Jev decisions cost fractions of a cent each; show two significant digits instead of collapsing them to "<$0.01". */
export function formatDecisionCostUsd(
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value) || value < 0)
    return "Unavailable";
  if (value > 0 && value < 0.01) {
    // Two significant digits: $0.000032 for a single request, $0.0041 for a day; never "$0.0000".
    const short = Number(value.toPrecision(2)).toString();
    return `$${short.includes("e") ? value.toFixed(8) : short}`;
  }
  return usdFormatter.format(value);
}

/** Savings can be negative (Jev added overhead without replacing a Haiku call). */
export function formatSignedCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return value < 0
    ? `-${formatDecisionCostUsd(-value)}`
    : formatDecisionCostUsd(value);
}

export function formatCostDate(date: string): string {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

export function totalsCoverage(
  totals?: CostTotals,
): RunCostSummary["coverage"] {
  if (
    !totals ||
    totals.totalCostUsd === null ||
    (totals.runs > 0 && totals.trackedRuns === 0)
  )
    return "unavailable";
  return totals.completeRuns === totals.runs ? "complete" : "partial";
}

export function costCoverageLabel(totals?: CostTotals): string {
  if (!totals) return "Reporting unavailable";
  if (totals.runs === 0) return "No runs";
  return `${totals.trackedRuns}/${totals.runs} runs reporting · ${totals.completeRuns} complete`;
}

export function rankJobCosts(jobs: JobCostSummary[]): JobCostSummary[] {
  return [...jobs].sort((first, second) => {
    if (first.totalCostUsd === null)
      return second.totalCostUsd === null
        ? first.jobName.localeCompare(second.jobName)
        : 1;
    if (second.totalCostUsd === null) return -1;
    return (
      second.totalCostUsd - first.totalCostUsd ||
      first.jobName.localeCompare(second.jobName)
    );
  });
}
