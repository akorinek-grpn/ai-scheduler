"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CostStatsResponse, CostTotals } from "../../shared/cost-types";
import { getCostStats, type CostPeriod } from "../lib/api-client";
import {
  COST_DISCLAIMER,
  costCoverageLabel,
  formatCostUsd,
  formatDecisionCostUsd,
  formatSignedCostUsd,
  rankJobCosts,
  totalsCoverage,
} from "../lib/cost-format";
import { CostChart } from "./cost-chart";
import { CostValue } from "./cost-value";
import { HostBadge } from "./host-view";
import { ModelLabels } from "./model-labels";

const number = (value: number | null | undefined): string =>
  (value ?? 0).toLocaleString("en-US");

/** A daemon older than the savings metric omits these fields; treat them as "nothing recorded". */
function decisionFields(totals: CostTotals) {
  return {
    requests: totals.decisionRequests ?? 0,
    inputTokens: totals.decisionInputTokens ?? 0,
    costUsd: totals.decisionCostUsd ?? null,
    savingsUsd: totals.decisionSavingsUsd ?? null,
    haikuSkipped: totals.decisionHaikuSkipped ?? 0,
    compared: totals.decisionCompared ?? 0,
    severityAgreed: totals.decisionSeverityAgreed ?? 0,
    followUpAgreed: totals.decisionFollowUpAgreed ?? 0,
  };
}

function MetricCard({
  label,
  totals,
}: {
  label: string;
  totals: CostTotals;
}): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/40 p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-2xl">
        <CostValue
          value={totals.totalCostUsd}
          coverage={totalsCoverage(totals)}
        />
      </dd>
      <dd className="mt-1.5 text-xs text-muted-foreground">
        {costCoverageLabel(totals)}
      </dd>
    </div>
  );
}

function DecisionFigure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "positive" | "negative";
}): React.ReactElement {
  const color =
    tone === "positive"
      ? "text-green-500"
      : tone === "negative"
        ? "text-amber-500"
        : "text-foreground";
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`mt-1.5 font-mono text-2xl tabular-nums ${color}`}>
        {value}
      </dd>
      {hint && <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function DecisionPeriod({
  label,
  totals,
}: {
  label: string;
  totals: CostTotals;
}): React.ReactElement {
  const d = decisionFields(totals);
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums">
        {number(d.requests)} {d.requests === 1 ? "request" : "requests"} ·{" "}
        {number(d.inputTokens)} input tokens
      </dd>
      <dd className="font-mono text-sm tabular-nums">
        {formatDecisionCostUsd(d.costUsd)} spent ·{" "}
        {formatSignedCostUsd(d.savingsUsd)} saved
      </dd>
    </div>
  );
}

/** Jev usage, spend and estimated savings on their own, independent of whether the rest of a run reported costs. */
export function DecisionUsageSummary({
  stats,
}: {
  stats: CostStatsResponse;
}): React.ReactElement {
  const period = decisionFields(stats.period);
  const savings = period.savingsUsd;
  const compared = period.compared;
  const baseline = stats.baselineHaikuEvaluationCostUsd ?? null;
  return (
    <section
      aria-labelledby="decision-usage-heading"
      className="space-y-4 rounded-md border border-border/60 bg-background/40 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="decision-usage-heading" className="text-base font-semibold">
          Jev decisions
        </h3>
        <p className="text-sm text-muted-foreground">
          TypeSafe System One via OpenRouter · {stats.days}-day window
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 xl:grid-cols-6">
        <DecisionFigure
          label="Requests"
          value={number(period.requests)}
          hint={`${number(period.inputTokens)} input tokens`}
        />
        <DecisionFigure
          label="Input tokens"
          value={number(period.inputTokens)}
          hint="output tokens are free"
        />
        <DecisionFigure
          label="Spend"
          value={formatDecisionCostUsd(period.costUsd)}
          hint="provider-reported charge"
        />
        <DecisionFigure
          label="Estimated savings"
          value={formatSignedCostUsd(savings)}
          hint={
            savings === null
              ? "needs a Haiku cost to compare"
              : savings >= 0
                ? "Haiku spend avoided minus Jev spend"
                : "Jev overhead; Haiku still ran"
          }
          tone={
            savings === null
              ? undefined
              : savings >= 0
                ? "positive"
                : "negative"
          }
        />
        <DecisionFigure
          label="Haiku calls skipped"
          value={number(period.haikuSkipped)}
          hint="enforce-mode runs with no Haiku call"
        />
        <DecisionFigure
          label="Agreement with Haiku"
          value={compared ? `${period.severityAgreed}/${compared}` : "n/a"}
          hint={
            compared
              ? `severity ${period.severityAgreed}/${compared} · follow-up ${period.followUpAgreed}/${compared}`
              : "no shadow or benchmark runs compared yet (Haiku is a noisy baseline, not truth)"
          }
        />
      </dl>
      <dl className="grid grid-cols-1 gap-x-5 gap-y-3 border-t border-border/50 pt-3 sm:grid-cols-3">
        <DecisionPeriod label="Today · UTC" totals={stats.today} />
        <DecisionPeriod label="This month · UTC" totals={stats.month} />
        <DecisionPeriod label="Retained history" totals={stats.retained} />
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Savings estimate: shadow runs count the Haiku cost of runs Jev judged
        clean (enforce would skip Haiku) minus Jev spend, and subtract Jev spend
        where Haiku would still run, as on every benchmark run; enforce runs
        without a Haiku call count the retained-history average Haiku evaluation
        cost
        {baseline !== null
          ? ` (${formatCostUsd(baseline)} over ${number(stats.baselineHaikuEvaluations ?? 0)} Haiku evaluations)`
          : " (no Haiku baseline yet)"}{" "}
        minus Jev spend. Requests whose provider reported no charge count as
        usage only.
      </p>
    </section>
  );
}

export function CostOverviewContent({
  stats,
}: {
  stats: CostStatsResponse;
}): React.ReactElement {
  const rankedJobs = useMemo(() => rankJobCosts(stats.jobs), [stats.jobs]);
  const unavailable = stats.period.runs - stats.period.trackedRuns;
  const partial = stats.period.trackedRuns - stats.period.completeRuns;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
        <MetricCard label="Today · UTC" totals={stats.today} />
        <MetricCard label="This month · UTC" totals={stats.month} />
        <MetricCard label="Retained history" totals={stats.retained} />
        <MetricCard label={`${stats.days}-day total`} totals={stats.period} />
        <div className="min-w-0 rounded-md border border-border/60 bg-background/40 p-4">
          <dt className="text-sm text-muted-foreground">
            Average / reporting run
          </dt>
          <dd className="mt-2 text-2xl">
            <CostValue
              value={stats.period.averageCostUsd}
              coverage={totalsCoverage(stats.period)}
            />
          </dd>
          <dd className="mt-1.5 text-xs text-muted-foreground">
            Selected period · missing costs excluded
          </dd>
        </div>
      </dl>
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">{stats.days}-day Execution</dt>
          <dd className="font-mono tabular-nums">
            {formatCostUsd(stats.period.executionCostUsd)}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Evaluation · Haiku</dt>
          <dd className="font-mono tabular-nums">
            {formatCostUsd(stats.period.evaluationCostUsd)}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Coverage</dt>
          <dd className="tabular-nums">
            {unavailable} runs unavailable · {partial} partially reported
          </dd>
        </div>
      </dl>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Partial totals include only reported costs; unavailable costs are not
        zero. Historical runs and scripts without reporting remain unavailable.
      </p>
      <ModelLabels
        label={`Execution models · ${stats.days} days`}
        models={stats.period.executionModels}
      />
      <DecisionUsageSummary stats={stats} />
      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CostChart daily={stats.daily} hosts={stats.hosts} />
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">
            Jobs by reported cost · {stats.days} days
          </h3>
          <p className="text-xs text-muted-foreground">
            Ranked by known amounts, not complete spend. Links show retained
            runs for each job.
          </p>
          {rankedJobs.length ? (
            <ol className="max-h-96 space-y-1 overflow-y-auto">
              {rankedJobs.map((job, index) => (
                <li key={`${job.host ?? ""}/${job.jobId}`}>
                  <Link
                    href={`/runs?job=${encodeURIComponent(job.jobId)}${job.host ? `&host=${encodeURIComponent(job.host)}` : ""}`}
                    className="flex min-h-11 items-start gap-3 rounded px-2 py-2 hover:bg-secondary/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
                  >
                    <span className="w-6 shrink-0 text-sm text-muted-foreground">
                      {index + 1}.
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5 break-words text-sm">
                        {job.jobName}
                        <HostBadge name={job.host} always />
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {costCoverageLabel(job)}
                      </span>
                      <ModelLabels models={job.executionModels} />
                    </span>
                    <span className="max-w-32 text-right text-base">
                      <CostValue
                        value={job.totalCostUsd}
                        coverage={totalsCoverage(job)}
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              No runs in this period.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function CostOverview(): React.ReactElement {
  const [days, setDays] = useState<CostPeriod>(30);
  const [snapshot, setSnapshot] = useState<{
    days: CostPeriod;
    data: CostStatsResponse;
  } | null>(null);
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
        if (!disposed)
          setError(
            failure instanceof Error
              ? failure.message
              : "Cost reports could not be loaded",
          );
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
    <section
      aria-labelledby="cost-overview-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="cost-overview-heading"
          className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Reported costs · USD
        </h2>
        <div
          role="group"
          aria-label="Cost time range"
          className="flex items-center gap-1"
        >
          {([7, 30, 90] as const).map((period) => (
            <button
              key={period}
              type="button"
              aria-pressed={days === period}
              onClick={() => setDays(period)}
              className={`min-h-9 rounded px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${days === period ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}`}
            >
              {period} days
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {COST_DISCLAIMER}
      </p>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-secondary/30 p-3 text-sm"
        >
          <p>
            {stats
              ? "Cost refresh failed; showing the last report. "
              : "Costs unavailable. "}
            {error}
          </p>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="min-h-9 rounded border border-border px-3 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
          >
            Retry costs
          </button>
        </div>
      )}
      {isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          {stats ? "Refreshing cost reports…" : "Loading cost reports…"}
        </p>
      )}
      <div aria-busy={isLoading}>
        {stats && <CostOverviewContent stats={stats} />}
      </div>
    </section>
  );
}
