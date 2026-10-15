import fs from "node:fs";
import type {
  CostDayBucket,
  CostStatsResponse,
  CostTotals,
  JobCostSummary,
} from "@shared/cost-types";
import type { RunEvaluation, RunSummary } from "@shared/types";
import { getExecutionModels } from "@shared/model-usage";
import { getEvalPath } from "@shared/paths";
import {
  readActivityRecords,
  runVerdictSchema,
  type ActivityRecord,
  type PreservedCost,
} from "./activity-store";
import { readRunCostFiles, sumCost, summarizeRunCost } from "./costs";
import { producedBy, type HostDataRoot } from "./host-data";
import { listRunSummaries } from "./run-history";

/** The parts of a run the cost totals read, whether the run is retained on disk or only preserved. */
type CostRun = Pick<
  RunSummary,
  "jobId" | "jobName" | "startedAt" | "cost" | "decision"
> & {
  runId?: string;
  /** Host that ran it, set when the stats are split per host. */
  host?: string;
  evaluation?: Pick<
    RunEvaluation,
    "severity" | "followUpNeeded" | "source" | "haikuBenchmark"
  >;
};

export function emptyCostTotals(): CostTotals {
  return {
    totalCostUsd: null,
    executionCostUsd: null,
    evaluationCostUsd: null,
    runs: 0,
    trackedRuns: 0,
    completeRuns: 0,
    averageCostUsd: null,
    executionModels: [],
    decisionRequests: 0,
    decisionInputTokens: 0,
    decisionCostUsd: null,
    decisionSavingsUsd: null,
    decisionHaikuSkipped: 0,
    decisionCompared: 0,
    decisionSeverityAgreed: 0,
    decisionFollowUpAgreed: 0,
  };
}

export interface HaikuBaseline {
  costUsd: number | null;
  evaluations: number;
}

/** Average Haiku evaluation cost over runs where Haiku produced a verdict (decided or benchmarked), not just a summary. */
export function haikuBaseline(runs: CostRun[]): HaikuBaseline {
  let total = 0;
  let count = 0;
  for (const run of runs) {
    const cost = run.cost?.evaluation?.costUsd;
    if (
      cost == null ||
      (run.evaluation?.source === "jev+haiku" && !run.evaluation.haikuBenchmark)
    )
      continue;
    total += cost;
    count += 1;
  }
  return { costUsd: count ? total / count : null, evaluations: count };
}

/** Jev usage is a separate metric: counted whenever the decision ran, even if nothing else reported a cost. */
function includeDecision(
  totals: CostTotals,
  run: CostRun,
  baseline: HaikuBaseline,
): void {
  const cost = run.cost;
  const usage = cost?.decision;
  if (!cost || !usage) return;
  totals.decisionRequests += usage.requests;
  totals.decisionInputTokens += usage.inputTokens;
  totals.decisionCostUsd = sumCost([totals.decisionCostUsd, usage.costUsd]);

  const verdict = run.decision;
  if (cost.decisionState !== "complete" || !verdict) return;
  const jevCost = usage.costUsd;
  const haikuCost = cost.evaluation?.costUsd ?? null;
  const source = run.evaluation?.source;
  let saving: number | null;
  if (source === "jev") {
    // Enforce, Haiku skipped: the avoided call is priced at the retained-history average.
    totals.decisionHaikuSkipped += 1;
    saving =
      baseline.costUsd !== null && jevCost !== null
        ? baseline.costUsd - jevCost
        : null;
  } else if (source === "jev+haiku") {
    // Enforce, Haiku still wrote the summary, or benchmark, Haiku judged every run: Jev was overhead.
    saving = jevCost !== null ? -jevCost : null;
    // Benchmark: Haiku's own verdict was recorded beside Jev's, so the run is a comparison.
    const benchmark = run.evaluation?.haikuBenchmark;
    if (benchmark) {
      totals.decisionCompared += 1;
      if (benchmark.severity === verdict.severity.label)
        totals.decisionSeverityAgreed += 1;
      if (benchmark.followUpNeeded === verdict.followUp.needed)
        totals.decisionFollowUpAgreed += 1;
    }
  } else {
    // Shadow: Haiku decided; Jev would have skipped Haiku only for a clean run.
    const evaluation = run.evaluation;
    if (evaluation) {
      totals.decisionCompared += 1;
      if (evaluation.severity === verdict.severity.label)
        totals.decisionSeverityAgreed += 1;
      if (evaluation.followUpNeeded === verdict.followUp.needed)
        totals.decisionFollowUpAgreed += 1;
    }
    const clean =
      (verdict.severity.label === "ok" || verdict.severity.label === "info") &&
      !verdict.followUp.needed;
    saving = clean
      ? haikuCost !== null && jevCost !== null
        ? haikuCost - jevCost
        : null
      : jevCost !== null
        ? -jevCost
        : null;
  }
  totals.decisionSavingsUsd = sumCost([totals.decisionSavingsUsd, saving]);
}

function includeRun(
  totals: CostTotals,
  run: CostRun,
  baseline: HaikuBaseline,
): void {
  totals.runs += 1;
  const cost = run.cost;
  totals.executionModels = [
    ...new Set([
      ...(totals.executionModels ?? []),
      ...getExecutionModels(cost),
    ]),
  ].sort();
  includeDecision(totals, run, baseline);
  if (!cost || cost.totalCostUsd === null) return;
  totals.trackedRuns += 1;
  if (cost.coverage === "complete") totals.completeRuns += 1;
  totals.totalCostUsd = sumCost([totals.totalCostUsd, cost.totalCostUsd]);
  totals.executionCostUsd = sumCost([
    totals.executionCostUsd,
    cost.executionCostUsd,
  ]);
  totals.evaluationCostUsd = sumCost([
    totals.evaluationCostUsd,
    cost.evaluationCostUsd,
  ]);
  totals.averageCostUsd = totals.totalCostUsd! / totals.trackedRuns;
}

/** Captured into the run's activity record, so the pruner keeps its cost when it deletes the run. */
export function snapshotRunCost(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
): PreservedCost {
  let verdict: PreservedCost["verdict"] = null;
  try {
    verdict =
      runVerdictSchema.safeParse(
        JSON.parse(
          fs.readFileSync(getEvalPath(projectRoot, jobId, runId), "utf-8"),
        ),
      ).data ?? null;
  } catch {
    // Not evaluated, or unreadable: the run keeps its costs without a verdict.
  }
  return { jobName, ...readRunCostFiles(projectRoot, jobId, runId), verdict };
}

function preservedRun(record: ActivityRecord, jobName: string): CostRun {
  const preserved = record.cost;
  // Pruned before costs were preserved: the run still counts, as one that reported no cost.
  if (!preserved)
    return { jobId: record.jobId, runId: record.runId, jobName, startedAt: record.startedAt };
  return {
    jobId: record.jobId,
    runId: record.runId,
    jobName: preserved.jobName,
    startedAt: record.startedAt,
    cost: summarizeRunCost(preserved),
    ...(preserved.decision?.decision
      ? { decision: preserved.decision.decision }
      : {}),
    ...(preserved.verdict ? { evaluation: preserved.verdict } : {}),
  };
}

/** Every recorded run: retained run directories, plus the preserved records of pruned runs. */
// SHORTCUT: re-reads every activity record on each call (~70 ms for 1.4k records, growing ~60/day).
// Cache records by mtime, or roll pruned costs up per day, once dashboard polls slow down noticeably.
// With `owner`, only the runs that host produced (see host-data.ts), tagged with its name.
function costHistory(projectRoot: string, now: Date, owner?: HostDataRoot): CostRun[] {
  const retainedRuns = listRunSummaries(projectRoot).filter(
    (run) => !owner || producedBy(owner, run.host),
  );
  const retained = new Set(
    retainedRuns.map((run) => `${run.jobId}/${run.runId}`),
  );
  // Newest first, so a job's current name labels its older pruned runs.
  const jobNames = new Map<string, string>();
  for (const run of retainedRuns)
    if (!jobNames.has(run.jobId)) jobNames.set(run.jobId, run.jobName);
  const runs: CostRun[] = [...retainedRuns];
  for (const record of readActivityRecords(projectRoot, { tolerant: owner ? !owner.isSelf : false })) {
    if (owner && !producedBy(owner, record.host)) continue;
    if (retained.has(`${record.jobId}/${record.runId}`)) continue;
    runs.push(preservedRun(record, jobNames.get(record.jobId) ?? record.jobId));
  }
  return runs
    .filter((run) => Date.parse(run.startedAt) <= now.getTime())
    .map((run) => (owner ? { ...run, host: owner.name } : run));
}

export function getRetainedJobCosts(
  projectRoot: string,
  now = new Date(),
  owner?: HostDataRoot,
): Map<string, CostTotals> {
  const jobs = new Map<string, CostTotals>();
  const runs = costHistory(projectRoot, now, owner);
  const baseline = haikuBaseline(runs);
  for (const run of runs) {
    const totals = jobs.get(run.jobId) ?? emptyCostTotals();
    includeRun(totals, run, baseline);
    jobs.set(run.jobId, totals);
  }
  return jobs;
}

/**
 * Cost totals and daily buckets. With `roots` (scheduler.yaml declares `hosts`), each host
 * counts only the runs it produced, a run held by several hosts counts once, and the response
 * carries every host's share beside their sum; per-job rows are then per host.
 */
export function getCostStats(
  projectRoot: string,
  days = 30,
  now = new Date(),
  roots?: HostDataRoot[],
): CostStatsResponse {
  if (!roots) return aggregateCostStats(costHistory(projectRoot, now), days, now);

  const seen = new Set<string>();
  const perHost = roots.map((root) => ({
    root,
    runs: costHistory(root.root, now, root).filter((run) => {
      const key = `${run.jobId}/${run.runId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
  const combined = aggregateCostStats(perHost.flatMap((h) => h.runs), days, now);
  combined.hosts = perHost.map(({ root, runs }) => {
    const share = aggregateCostStats(runs, days, now);
    return {
      name: root.name,
      role: root.role,
      isSelf: root.isSelf,
      today: share.today,
      month: share.month,
      retained: share.retained,
      period: share.period,
      daily: share.daily,
    };
  });
  return combined;
}

function aggregateCostStats(
  runs: CostRun[],
  days: number,
  now: Date,
): CostStatsResponse {
  const todayKey = now.toISOString().slice(0, 10);
  const daily: CostDayBucket[] = [];
  for (let index = days - 1; index >= 0; index--) {
    const date = new Date(`${todayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - index);
    daily.push({ date: date.toISOString().slice(0, 10), ...emptyCostTotals() });
  }
  const buckets = new Map(daily.map((bucket) => [bucket.date, bucket]));
  const jobs = new Map<string, JobCostSummary>();
  const baseline = haikuBaseline(runs);
  const stats: CostStatsResponse = {
    currency: "USD",
    timezone: "UTC",
    days,
    daily,
    jobs: [],
    today: emptyCostTotals(),
    month: emptyCostTotals(),
    retained: emptyCostTotals(),
    period: emptyCostTotals(),
    baselineHaikuEvaluationCostUsd: baseline.costUsd,
    baselineHaikuEvaluations: baseline.evaluations,
  };
  for (const run of runs) {
    const date = new Date(run.startedAt).toISOString().slice(0, 10);
    includeRun(stats.retained, run, baseline);
    if (date === todayKey) includeRun(stats.today, run, baseline);
    if (date.slice(0, 7) === todayKey.slice(0, 7))
      includeRun(stats.month, run, baseline);
    const bucket = buckets.get(date);
    if (!bucket) continue;
    includeRun(bucket, run, baseline);
    includeRun(stats.period, run, baseline);
    const jobKey = run.host ? `${run.host}/${run.jobId}` : run.jobId;
    const job = jobs.get(jobKey) ?? {
      jobId: run.jobId,
      jobName: run.jobName,
      ...(run.host ? { host: run.host } : {}),
      ...emptyCostTotals(),
    };
    includeRun(job, run, baseline);
    jobs.set(jobKey, job);
  }
  stats.jobs = [...jobs.values()].sort(
    (left, right) =>
      (right.totalCostUsd ?? -1) - (left.totalCostUsd ?? -1) ||
      left.jobName.localeCompare(right.jobName),
  );
  return stats;
}
