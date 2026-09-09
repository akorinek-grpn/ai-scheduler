import { describe, expect, it } from "vitest";
import type { CostTotals, JobCostSummary } from "../../../shared/cost-types";
import { costCoverageLabel, formatCostUsd, formatCostDate, rankJobCosts, totalsCoverage } from "../cost-format";

const totals: CostTotals = {
  totalCostUsd: 2,
  executionCostUsd: 1.5,
  evaluationCostUsd: 0.5,
  runs: 3,
  trackedRuns: 2,
  completeRuns: 1,
  averageCostUsd: 1,
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

  it("distinguishes partial totals, absent reporting and an empty period", () => {
    expect(totalsCoverage(totals)).toBe("partial");
    expect(costCoverageLabel(totals)).toBe("2/3 runs reporting · 1 complete");
    expect(totalsCoverage({ ...totals, completeRuns: 3, trackedRuns: 3 })).toBe("complete");
    expect(totalsCoverage({ ...totals, totalCostUsd: null, trackedRuns: 0, completeRuns: 0 })).toBe("unavailable");
    expect(costCoverageLabel({ ...totals, runs: 0, trackedRuns: 0, completeRuns: 0 })).toBe("No runs");
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
    expect(rankJobCosts(jobs).map((job) => job.jobId)).toEqual(["largest", "zero", "unknown"]);
    expect(jobs[0].jobId).toBe("unknown");
  });
});
