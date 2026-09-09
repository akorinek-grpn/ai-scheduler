import type { CostDayBucket, CostStatsResponse, CostTotals, JobCostSummary } from "@shared/cost-types";
import type { RunSummary } from "@shared/types";
import { getExecutionModels } from "@shared/model-usage";
import { sumCost } from "./costs";
import { listRunSummaries } from "./run-history";

export function emptyCostTotals(): CostTotals {
  return { totalCostUsd: null, executionCostUsd: null, evaluationCostUsd: null, runs: 0, trackedRuns: 0, completeRuns: 0, averageCostUsd: null, executionModels: [] };
}

function includeRun(totals: CostTotals, run: RunSummary): void {
  totals.runs += 1;
  const cost = run.cost;
  totals.executionModels = [...new Set([...(totals.executionModels ?? []), ...getExecutionModels(cost)])].sort();
  if (!cost || cost.totalCostUsd === null) return;
  totals.trackedRuns += 1;
  if (cost.coverage === "complete") totals.completeRuns += 1;
  totals.totalCostUsd = sumCost([totals.totalCostUsd, cost.totalCostUsd]);
  totals.executionCostUsd = sumCost([totals.executionCostUsd, cost.executionCostUsd]);
  totals.evaluationCostUsd = sumCost([totals.evaluationCostUsd, cost.evaluationCostUsd]);
  totals.averageCostUsd = totals.totalCostUsd! / totals.trackedRuns;
}

function retainedRuns(projectRoot: string, now: Date): RunSummary[] {
  return listRunSummaries(projectRoot).filter((run) => Date.parse(run.startedAt) <= now.getTime());
}

export function getRetainedJobCosts(projectRoot: string, now = new Date()): Map<string, CostTotals> {
  const jobs = new Map<string, CostTotals>();
  for (const run of retainedRuns(projectRoot, now)) {
    const totals = jobs.get(run.jobId) ?? emptyCostTotals();
    includeRun(totals, run);
    jobs.set(run.jobId, totals);
  }
  return jobs;
}

export function getCostStats(projectRoot: string, days = 30, now = new Date()): CostStatsResponse {
  const todayKey = now.toISOString().slice(0, 10);
  const daily: CostDayBucket[] = [];
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(`${todayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - index);
    daily.push({ date: date.toISOString().slice(0, 10), ...emptyCostTotals() });
  }
  const buckets = new Map(daily.map((bucket) => [bucket.date, bucket]));
  const jobs = new Map<string, JobCostSummary>();
  const stats: CostStatsResponse = {
    currency: "USD", timezone: "UTC", days, daily, jobs: [],
    today: emptyCostTotals(), month: emptyCostTotals(), retained: emptyCostTotals(), period: emptyCostTotals(),
  };
  for (const run of retainedRuns(projectRoot, now)) {
    const date = new Date(run.startedAt).toISOString().slice(0, 10);
    includeRun(stats.retained, run);
    if (date === todayKey) includeRun(stats.today, run);
    if (date.slice(0, 7) === todayKey.slice(0, 7)) includeRun(stats.month, run);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    includeRun(bucket, run);
    includeRun(stats.period, run);
    const job = jobs.get(run.jobId) ?? { jobId: run.jobId, jobName: run.jobName, ...emptyCostTotals() };
    includeRun(job, run);
    jobs.set(run.jobId, job);
  }
  stats.jobs = [...jobs.values()].sort((left, right) => (right.totalCostUsd ?? -1) - (left.totalCostUsd ?? -1) || left.jobName.localeCompare(right.jobName));
  return stats;
}
