import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CostStatsResponse, CostTotals, RunCostSummary } from "../../../shared/cost-types";
import { CostValue, JobCost } from "../cost-value";
import { RunCostDetails } from "../run-cost-details";
import { CostOverview, CostOverviewContent } from "../cost-overview";
import { CostChart } from "../cost-chart";
import { ModelLabels } from "../model-labels";

const totals: CostTotals = {
  totalCostUsd: 1.5, executionCostUsd: 1.25, evaluationCostUsd: 0.25,
  runs: 3, trackedRuns: 2, completeRuns: 1, averageCostUsd: 0.75,
};
const unknown: RunCostSummary = {
  currency: "USD", totalCostUsd: null, executionCostUsd: null, evaluationCostUsd: null,
  coverage: "unavailable", evaluationState: "unavailable", attempts: [], evaluation: null, tokens: null,
};

describe("cost visibility", () => {
  it("shows actual model IDs instead of substituting a configured alias", () => {
    const html = renderToStaticMarkup(createElement(ModelLabels, { models: ["claude-opus-4-6", "claude-sonnet-4-6"], configuredModel: "haiku" }));
    expect(html).toContain("Reported models");
    expect(html).toContain("claude-opus-4-6");
    expect(html).toContain("claude-sonnet-4-6");
    expect(html).not.toContain("haiku");
  });

  it("labels configuration-only models and missing model reporting honestly", () => {
    const configured = renderToStaticMarkup(createElement(ModelLabels, { configuredModel: "opus" }));
    expect(configured).toContain("Configured model");
    expect(configured).toContain("opus");
    expect(configured).not.toContain("Reported models");
    expect(renderToStaticMarkup(createElement(ModelLabels))).toContain("Models unavailable");
  });

  it("puts execution and evaluation models outside the collapsed run breakdown", () => {
    const report = (model: string) => ({
      id: "claude", label: "Session", source: "claude" as const, costUsd: 1, tokens: null,
      models: [{ model, costUsd: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    });
    const cost: RunCostSummary = {
      ...unknown,
      attempts: [{ attempt: 1, complete: true, entries: [report("claude-opus-4-6")] }],
      evaluation: report("claude-haiku-4-5"),
    };
    const visible = renderToStaticMarkup(createElement(RunCostDetails, { cost })).split("<details")[0];
    expect(visible).toContain("Execution models");
    expect(visible).toContain("claude-opus-4-6");
    expect(visible).toContain("Evaluation models");
    expect(visible).toContain("claude-haiku-4-5");
  });

  it("shows period and per-job execution models beside aggregated costs", () => {
    const withModels = { ...totals, executionModels: ["claude-sonnet-4-6"] };
    const stats: CostStatsResponse = {
      currency: "USD", timezone: "UTC", days: 7,
      today: withModels, month: withModels, retained: withModels, period: withModels,
      daily: [], jobs: [{ ...withModels, jobId: "job", jobName: "Model-aware job" }],
    };
    const html = renderToStaticMarkup(createElement(CostOverviewContent, { stats }));
    expect(html).toContain("Execution models · 7 days");
    expect(html.match(/claude-sonnet-4-6/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(JobCost, { jobId: "job", cost: withModels }))).toContain("claude-sonnet-4-6");
  });

  it("shows unavailable without a dollar value and marks partial costs", () => {
    const missing = renderToStaticMarkup(createElement(CostValue, { value: null, coverage: "unavailable" }));
    expect(missing).toContain("Unavailable");
    expect(missing).not.toContain("$0.00");
    expect(renderToStaticMarkup(createElement(CostValue, { value: 1.5, coverage: "partial" }))).toContain("partial");
  });

  it("labels job costs as retained, with reporting coverage and a filter link", () => {
    const html = renderToStaticMarkup(createElement(JobCost, { jobId: "job name", cost: totals }));
    expect(html).toContain("Retained");
    expect(html).toContain("2/3 runs reporting");
    expect(html).toContain('/runs?job=job%20name');
    expect(html).toContain("API-equivalent");
  });

  it("does not invent costs or tokens for historical and non-reporting script runs", () => {
    const html = renderToStaticMarkup(createElement(RunCostDetails, { cost: unknown }));
    expect(html).toContain("Unavailable");
    expect(html).toContain("Historical runs");
    expect(html).toContain("scripts without cost reporting");
    expect(html).toContain("not subscription invoices");
    expect(html).toContain("Reported tokens unavailable");
    expect(html).not.toContain("$0.00");
  });

  it("separates execution, pending evaluation, attempts, script tasks and model reporting", () => {
    const cost: RunCostSummary = {
      ...unknown, totalCostUsd: 1.25, executionCostUsd: 1.25, coverage: "partial", evaluationState: "pending",
      attempts: [
        { attempt: 1, complete: false, entries: [] },
        { attempt: 2, complete: true, entries: [{
          id: "task-id", label: "Research task", source: "script", costUsd: 1.25,
          tokens: null, models: [{ model: "reported-model", inputTokens: 40, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 5, costUsd: null }],
        }] },
      ],
    };
    const html = renderToStaticMarkup(createElement(RunCostDetails, { cost }));
    for (const text of ["Execution", "Evaluation", "Pending", "Attempt 1", "Attempt 2", "Research task", "reported-model", "Cache read", "Cache write", "partial"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("$0.00");
  });

  it("separates evaluator reporting from execution reporting", () => {
    const html = renderToStaticMarkup(createElement(RunCostDetails, { cost: {
      ...unknown, totalCostUsd: 0.25, evaluationCostUsd: 0.25, coverage: "partial", evaluationState: "complete",
      evaluation: { id: "eval", label: "Evaluator", source: "claude", costUsd: 0.25, tokens: null, models: [] },
    } }));
    expect(html).toContain("Evaluator");
    expect(html).toContain("$0.25");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("$0.00");
  });

  it("renders the initial loading state and accessible period controls", () => {
    const html = renderToStaticMarkup(createElement(CostOverview));
    expect(html).toContain("Loading cost reports");
    for (const days of [7, 30, 90]) expect(html).toContain(`${days} days`);
    expect(html).toContain('aria-pressed="true"');
  });

  it("keeps retained/UTC semantics, partial averages and accessible daily values", () => {
    const stats: CostStatsResponse = {
      currency: "USD", timezone: "UTC", days: 7,
      today: totals, month: totals, retained: totals, period: totals,
      daily: [{ ...totals, date: "2026-09-09" }],
      jobs: [{ ...totals, jobId: "job", jobName: "Costly job" }],
    };
    const html = renderToStaticMarkup(createElement(CostOverviewContent, { stats }));
    for (const label of ["Today", "This month", "Retained history", "7-day total", "Average / reporting run", "partial", "UTC", "Daily values", "Costly job", "Execution", "Evaluation"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("/runs?job=job");
  });

  it("keeps chart gaps unavailable rather than inventing zero-dollar days", () => {
    const daily = [{ ...totals, date: "2026-09-09", totalCostUsd: null, executionCostUsd: null, evaluationCostUsd: null, trackedRuns: 0, completeRuns: 0, averageCostUsd: null }];
    const html = renderToStaticMarkup(createElement(CostChart, { daily }));
    expect(html).toContain("No reported costs in this period");
    expect(html).toContain("2026-09-09");
    expect(html).toContain("0/3 runs reporting");
    expect(html).not.toContain("$0.00");
  });

  it("renders a genuinely reported zero-dollar run distinctly from missing reporting", () => {
    const html = renderToStaticMarkup(createElement(RunCostDetails, { cost: {
      ...unknown, totalCostUsd: 0, executionCostUsd: 0, coverage: "complete",
      attempts: [{ attempt: 1, complete: true, entries: [{ id: "zero", label: "Zero report", source: "script", costUsd: 0, tokens: null, models: [] }] }],
    } }));
    expect(html).toContain("$0.00");
    expect(html).toContain("Complete reporting for this run");
    expect(html).toContain("Evaluation reporting unavailable");
  });
});
