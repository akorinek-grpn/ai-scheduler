import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostTracker, readRunCost, writeRunCost, writeEvaluationCost } from "../costs";
import { getRunDir } from "@shared/paths";

const result = (cost: unknown = 0.12): string => JSON.stringify({
  type: "result", subtype: "success", total_cost_usd: cost,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  modelUsage: { "claude-test": { costUSD: cost, inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 33, cacheCreationInputTokens: 44 } },
});

describe("CostTracker", () => {
  it("uses whole-tree model tokens and replaces cumulative results instead of double counting", () => {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(result());
    tracker.consume(result());
    tracker.consume(result(0.2));
    expect(tracker.snapshot()).toMatchObject({ attempt: 1, complete: true, entries: [{ costUsd: 0.2, tokens: {
      inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44,
    } }] });
    expect(tracker.snapshot().entries).toHaveLength(1);
  });

  it("does not count assistant messages or nested subagent results twice", () => {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 50 } } }));
    tracker.consume(JSON.stringify({ ...JSON.parse(result()), parent_tool_use_id: "task-1" }));
    expect(tracker.snapshot()).toEqual({ attempt: 1, complete: false, entries: [] });
  });

  it.each([null, -1, "2.00", {}, 1e309])("rejects invalid cost %j rather than fabricating zero", (cost) => {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(result(cost));
    expect(tracker.snapshot().entries).toEqual([]);
  });

  it("accepts an explicitly reported zero", () => {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(result(0));
    expect(tracker.snapshot()).toMatchObject({ complete: true, entries: [{ costUsd: 0 }] });
  });

  it("retains reported failed-request costs but flags a zeroed crash result as incomplete", () => {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(JSON.stringify({ ...JSON.parse(result(0.15)), subtype: "error_max_turns" }));
    tracker.consume(JSON.stringify({ ...JSON.parse(result(0)), subtype: "error_during_execution" }));
    expect(tracker.snapshot()).toMatchObject({ complete: false, entries: [{ costUsd: 0.15 }] });
  });

  it("supports cumulative script task reports without mixing them with native Claude costs", () => {
    const tracker = new CostTracker("script", 2);
    tracker.consume("ordinary output $20");
    tracker.consume(result(99));
    tracker.consume('{"type":"scheduler_cost","id":"brief","label":"Briefing","currency":"USD","cost_usd":0.1}');
    tracker.consume('{"type":"scheduler_cost","id":"brief","label":"Briefing","currency":"USD","cost_usd":0.2}');
    tracker.consume('{"type":"scheduler_cost","id":"summary","currency":"USD","cost_usd":0.3}');
    expect(tracker.snapshot()).toMatchObject({ complete: false, entries: [{ id: "brief", costUsd: 0.2 }, { id: "summary", costUsd: 0.3 }] });
    tracker.consume('{"type":"scheduler_cost_complete"}');
    expect(tracker.snapshot().complete).toBe(true);
  });

  it("requires USD and valid task identifiers; completeness alone never implies zero spend", () => {
    const tracker = new CostTracker("script", 1);
    for (const line of [
      '{"type":"scheduler_cost","id":"x","currency":"EUR","cost_usd":1}',
      '{"type":"scheduler_cost","cost_usd":1}',
      '{"type":"scheduler_cost_complete"}', "null", "[]", "{bad JSON",
    ]) tracker.consume(line);
    expect(tracker.snapshot()).toEqual({ attempt: 1, complete: false, entries: [] });
  });
});

describe("run cost persistence", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-costs-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("leaves legacy or corrupt costs unavailable, not free", () => {
    const directory = getRunDir(root, "job", "run");
    fs.mkdirSync(directory, { recursive: true });
    expect(readRunCost(root, "job", "run")).toMatchObject({ totalCostUsd: null, coverage: "unavailable" });
    fs.writeFileSync(path.join(directory, "costs.json"), '{"version":1,"attempts":[{"entries":[{"costUsd":-1}]}]}');
    expect(readRunCost(root, "job", "run").totalCostUsd).toBeNull();
  });

  it("adds all retry attempts and evaluator cost without lost updates or rounding artifacts", () => {
    fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
    const first = new CostTracker("claude", 1);
    const retry = new CostTracker("claude", 2);
    first.consume(result(0.1));
    retry.consume(result(0.2));
    writeEvaluationCost(root, "job", "run", "complete", first.snapshot().entries[0]);
    writeRunCost(root, "job", "run", [first.snapshot(), retry.snapshot()]);
    expect(readRunCost(root, "job", "run")).toMatchObject({
      totalCostUsd: 0.4, executionCostUsd: 0.3, evaluationCostUsd: 0.1, coverage: "complete",
    });
  });

  it("marks evaluator-only totals and missing retry costs as partial", () => {
    fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
    const tracker = new CostTracker("claude", 1);
    tracker.consume(result());
    writeEvaluationCost(root, "job", "run", "complete", tracker.snapshot().entries[0]);
    expect(readRunCost(root, "job", "run")).toMatchObject({ totalCostUsd: 0.12, executionCostUsd: null, coverage: "partial" });
    writeRunCost(root, "job", "run", [tracker.snapshot(), { attempt: 2, complete: false, entries: [] }]);
    expect(readRunCost(root, "job", "run")).toMatchObject({ totalCostUsd: 0.24, coverage: "partial" });
  });
});
