"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CostStatsResponse, CostTotals } from "../../shared/cost-types";
import { getCostStats, type CostPeriod } from "../lib/api-client";
import { COST_DISCLAIMER, costCoverageLabel, formatCostUsd, rankJobCosts, totalsCoverage } from "../lib/cost-format";
import { CostChart } from "./cost-chart";
import { CostValue } from "./cost-value";
import { ModelLabels } from "./model-labels";

function CostMetric({ label, totals }: { label: string; totals: CostTotals }): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg"><CostValue value={totals.totalCostUsd} coverage={totalsCoverage(totals)} /></dd>
      <dd className="mt-1 text-[11px] text-muted-foreground">{costCoverageLabel(totals)}</dd>
    </div>
  );
}

export function CostOverviewContent({ stats }: { stats: CostStatsResponse }): React.ReactElement {
  const rankedJobs = useMemo(() => rankJobCosts(stats.jobs), [stats.jobs]);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-5">
        <CostMetric label="Today · UTC" totals={stats.today} />
        <CostMetric label="This month · UTC" totals={stats.month} />
        <CostMetric label="Retained history" totals={stats.retained} />
        <CostMetric label={`${stats.days}-day total`} totals={stats.period} />
        <div>
          <dt className="text-[12px] text-muted-foreground">Average / reporting run</dt>
          <dd className="mt-1 text-lg"><CostValue value={stats.period.averageCostUsd} coverage={totalsCoverage(stats.period)} /></dd>
          <dd className="mt-1 text-[11px] text-muted-foreground">Selected period · missing costs excluded</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border/50 pt-3 text-[12px] text-muted-foreground">
        <span>{stats.days}-day Execution: <span className="font-mono tabular-nums">{formatCostUsd(stats.period.executionCostUsd)}</span></span>
        <span>Evaluation: <span className="font-mono tabular-nums">{formatCostUsd(stats.period.evaluationCostUsd)}</span></span>
        <span>{stats.period.runs - stats.period.trackedRuns} runs unavailable · {stats.period.trackedRuns - stats.period.completeRuns} partially reported</span>
      </div>
      <p className="text-[11px] text-muted-foreground">Partial totals include only reported costs; unavailable costs are not zero. Historical runs and scripts without reporting remain unavailable.</p>
      <ModelLabels label={`Execution models · ${stats.days} days`} models={stats.period.executionModels} />
      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CostChart daily={stats.daily} />
        <div className="min-w-0 space-y-2">
          <h3 className="text-[12px] font-medium">Jobs by reported cost · {stats.days} days</h3>
          <p className="text-[11px] text-muted-foreground">Ranked by known amounts, not complete spend. Links show retained runs for each job.</p>
          {rankedJobs.length ? (
            <ol className="max-h-72 space-y-1 overflow-y-auto">
              {rankedJobs.map((job, index) => (
                <li key={job.jobId}>
                  <Link href={`/runs?job=${encodeURIComponent(job.jobId)}`} className="flex min-h-10 items-start gap-2 rounded px-2 py-1.5 hover:bg-secondary/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2">
                    <span className="w-5 shrink-0 text-[11px] text-muted-foreground">{index + 1}.</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[12px]">{job.jobName}</span>
                      <span className="block text-[11px] text-muted-foreground">{costCoverageLabel(job)}</span>
                      <ModelLabels models={job.executionModels} />
                    </span>
                    <span className="max-w-28 text-right text-[12px]"><CostValue value={job.totalCostUsd} coverage={totalsCoverage(job)} /></span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : <p className="py-4 text-[12px] text-muted-foreground">No retained runs in this period.</p>}
        </div>
      </div>
    </div>
  );
}

export function CostOverview(): React.ReactElement {
  const [days, setDays] = useState<CostPeriod>(30);
  const [snapshot, setSnapshot] = useState<{ days: CostPeriod; data: CostStatsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const stats = snapshot?.days === days ? snapshot.data : null;

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | null = null;
    setError(null);
    const load = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      setIsLoading(true);
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const data = await getCostStats(days, controller.signal);
        if (!disposed) {
          setSnapshot({ days, data });
          setError(null);
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "Cost reports could not be loaded");
      } finally {
        clearTimeout(timeout);
        pending = false;
        if (!disposed) setIsLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
    };
  }, [days, retry]);

  return (
    <section aria-labelledby="cost-overview-heading" className="space-y-3 rounded border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="cost-overview-heading" className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Reported costs · USD</h2>
        <div role="group" aria-label="Cost time range" className="flex items-center gap-1">
          {([7, 30, 90] as const).map((period) => (
            <button key={period} type="button" aria-pressed={days === period} onClick={() => setDays(period)} className={`min-h-8 rounded px-3 py-1 text-[12px] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${days === period ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}>
              {period} days
            </button>
          ))}
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">{COST_DISCLAIMER}</p>
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-secondary/30 p-3 text-[12px]">
          <p>{stats ? "Cost refresh failed; showing the last report. " : "Costs unavailable. "}{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)} className="min-h-8 rounded border border-border px-3 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring">Retry costs</button>
        </div>
      )}
      {isLoading && <p role="status" className="text-[12px] text-muted-foreground">{stats ? "Refreshing cost reports…" : "Loading cost reports…"}</p>}
      <div aria-busy={isLoading}>{stats && <CostOverviewContent stats={stats} />}</div>
    </section>
  );
}
