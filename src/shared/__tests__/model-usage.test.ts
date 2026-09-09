import { describe, expect, it } from "vitest";
import type { CostEntry, RunCostSummary } from "../cost-types";
import { getExecutionModels, getReportedModels } from "../model-usage";

const entry: CostEntry = {
  id: "session", label: "Session", source: "claude", costUsd: 1, tokens: null,
  models: ["claude-sonnet-4-6", "claude-opus-4-6"].map((model) => ({
    model, costUsd: null, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
  })),
};

describe("reported model names", () => {
  it("deduplicates models across attempts without including the evaluator model", () => {
    const cost: RunCostSummary = {
      currency: "USD", totalCostUsd: 2.1, executionCostUsd: 2, evaluationCostUsd: 0.1,
      coverage: "partial", evaluationState: "complete", tokens: null,
      attempts: [1, 2].map((attempt) => ({ attempt, complete: false, entries: [entry] })),
      evaluation: { ...entry, models: [{ ...entry.models[0], model: "claude-haiku-4-5" }] },
    };
    expect(getExecutionModels(cost)).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(getReportedModels([cost.evaluation!])).toEqual(["claude-haiku-4-5"]);
  });

  it("does not infer missing models from a cost report or empty model names", () => {
    expect(getExecutionModels()).toEqual([]);
    expect(getReportedModels([{ ...entry, models: [] }])).toEqual([]);
    expect(getReportedModels([{ ...entry, models: [{ ...entry.models[0], model: "  " }] }])).toEqual([]);
  });

  it("includes a script task's explicit model without inventing a token breakdown", () => {
    expect(getReportedModels([{ ...entry, source: "script", model: "task-model", models: [] }])).toEqual(["task-model"]);
  });
});
