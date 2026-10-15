import { describe, expect, it } from "vitest";
import type { CostTotals, JobCostSummary } from "../../../shared/cost-types";
import {
  costCoverageLabel,
  formatCostUsd,
  formatCostDate,
  formatDecisionCostUsd,
  formatSignedCostUsd,
  rankJobCosts,
  totalsCoverage,
} from "../cost-format";

const totals: CostTotals = {
  totalCostUsd: 2,
  executionCostUsd: 1.5,
  evaluationCostUsd: 0.5,
  runs: 3,
  trackedRuns: 2,
  completeRuns: 1,
  averageCostUsd: 1,
  // contract extension 2026-10-01: Jev decision metric
  decisionRequests: 0,
  decisionInputTokens: 0,
  decisionCostUsd: null,
  decisionSavingsUsd: null,
  decisionHaikuSkipped: 0,
  decisionCompared: 0,
  decisionSeverityAgreed: 0,
  decisionFollowUpAgreed: 0,
};

describe("reported cost formatting", () => {
  it("never formats unknown or invalid costs as zero", () => {
    expect(formatCostUsd(null)).toBe("Unavailable");
    expect(formatCostUsd(undefined)).toBe("Unavailable");
    expect(formatCostUsd(Number.NaN)).toBe("Unavailable");
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.001)).toBe("<$0.01");
    expect(formatCostUsd(12.34)).toBe("$12.34");
  });

  it("keeps sub-cent Jev decision spend legible instead of collapsing it to zero", () => {
    expect(formatDecisionCostUsd(null)).toBe("Unavailable");
    expect(formatDecisionCostUsd(0)).toBe("$0.00");
    expect(formatDecisionCostUsd(0.0000317)).toBe("$0.000032");
    expect(formatDecisionCostUsd(0.000222768)).toBe("$0.00022");
    expect(formatDecisionCostUsd(0.0041)).toBe("$0.0041");
    expect(formatDecisionCostUsd(0.012)).toBe("$0.01");
    expect(formatDecisionCostUsd(1.5)).toBe("$1.50");
    expect(formatSignedCostUsd(-0.0003)).toBe("-$0.0003");
    expect(formatSignedCostUsd(0.2134)).toBe("$0.21");
    expect(formatSignedCostUsd(null)).toBe("Unavailable");
  });

  it("distinguishes partial totals, absent reporting and an empty period", () => {
    expect(totalsCoverage(totals)).toBe("partial");
    expect(costCoverageLabel(totals)).toBe("2/3 runs reporting · 1 complete");
    expect(totalsCoverage({ ...totals, completeRuns: 3, trackedRuns: 3 })).toBe(
      "complete",
    );
    expect(
      totalsCoverage({
        ...totals,
        totalCostUsd: null,
        trackedRuns: 0,
        completeRuns: 0,
      }),
    ).toBe("unavailable");
    expect(
      costCoverageLabel({
        ...totals,
        runs: 0,
        trackedRuns: 0,
        completeRuns: 0,
      }),
    ).toBe("No runs");
  });

  it("keeps UTC dates independent of local timezone", () => {
    expect(formatCostDate("2026-09-09")).toBe("Sep 9");
  });

  it("ranks known costs ahead of unknown costs without mutating the response", () => {
    const jobs: JobCostSummary[] = [
      { ...totals, jobId: "unknown", jobName: "Unknown", totalCostUsd: null },
      { ...totals, jobId: "zero", jobName: "Zero", totalCostUsd: 0 },
      { ...totals, jobId: "largest", jobName: "Largest", totalCostUsd: 10 },
    ];
    expect(rankJobCosts(jobs).map((job) => job.jobId)).toEqual([
      "largest",
      "zero",
      "unknown",
    ]);
    expect(jobs[0].jobId).toBe("unknown");
  });
});
