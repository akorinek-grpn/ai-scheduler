import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCostStats, getRetainedJobCosts } from "../cost-stats";
import { CostTracker, writeRunCost, writeEvaluationCost } from "../costs";
import { getRunDir } from "@shared/paths";
import { readRunSummary } from "../run-history";

let root: string;
const now = new Date("2026-09-09T12:00:00Z");
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-cost-stats-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function seed(jobId: string, runId: string, startedAt: string, cost: number | null, evaluated = true): void {
  const directory = getRunDir(root, jobId, runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, runId, jobConfig: { name: jobId, directory: "/tmp" }, trigger: "manual", startedAt }));
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "failed", exitCode: 1, startedAt, finishedAt: startedAt }));
  if (cost !== null) {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(JSON.stringify({ type: "result", total_cost_usd: cost }));
    writeRunCost(root, jobId, runId, [tracker.snapshot()]);
    if (evaluated) {
      const evaluator = new CostTracker("claude", 1);
      evaluator.consume('{"type":"result","total_cost_usd":0}');
      writeEvaluationCost(root, jobId, runId, "complete", evaluator.snapshot().entries[0]);
    }
  }
}

describe("cost aggregation", () => {
  it("preserves an explicitly reported script model without requiring token counts", () => {
    seed("script", "run", now.toISOString(), null);
    const tracker = new CostTracker("script", 1);
    tracker.consume(JSON.stringify({ type: "scheduler_cost", id: "task", currency: "USD", cost_usd: 0.25, model: "task-model" }));
    tracker.consume('{"type":"scheduler_cost_complete"}');
    writeRunCost(root, "script", "run", [tracker.snapshot()]);
    expect(getCostStats(root, 7, now).period.executionModels).toEqual(["task-model"]);
    expect(readRunSummary(root, "script", "run")?.cost?.attempts[0].entries[0].tokens).toBeNull();
  });

  it("rolls up only reported execution models within each period and retained job history", () => {
    seed("job", "current", now.toISOString(), 1);
    seed("job", "old", "2026-08-01T12:00:00Z", 1);
    const report = (model: string): string => JSON.stringify({
      type: "result", total_cost_usd: 1,
      modelUsage: { [model]: { inputTokens: 100, outputTokens: 20, costUSD: 1 } },
    });
    const current = new CostTracker("claude", 1);
    current.consume(report("claude-sonnet-4-6"));
    writeRunCost(root, "job", "current", [current.snapshot(), { ...current.snapshot(), attempt: 2 }]);
    const old = new CostTracker("claude", 1);
    old.consume(report("claude-opus-4-6"));
    writeRunCost(root, "job", "old", [old.snapshot()]);
    const evaluator = new CostTracker("claude", 1);
    evaluator.consume(report("claude-haiku-4-5"));
    writeEvaluationCost(root, "job", "current", "complete", evaluator.snapshot().entries[0]);

    const stats = getCostStats(root, 7, now);
    expect(stats.period.executionModels).toEqual(["claude-sonnet-4-6"]);
    expect(stats.jobs[0].executionModels).toEqual(["claude-sonnet-4-6"]);
    expect(stats.retained.executionModels).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(getRetainedJobCosts(root, now).get("job")?.executionModels).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(stats.period.totalCostUsd).toBe(3);
  });

  it("exposes the run's snapshotted configuration only as a fallback, never for script jobs", () => {
    seed("job", "legacy", now.toISOString(), null);
    const metaPath = path.join(getRunDir(root, "job", "legacy"), "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.jobConfig.model = "opus";
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    expect(readRunSummary(root, "job", "legacy")?.configuredModel).toBe("opus");
    expect(getCostStats(root, 7, now).period.executionModels).toEqual([]);
    meta.jobConfig.type = "script";
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    expect(readRunSummary(root, "job", "legacy")?.configuredModel).toBeUndefined();
  });

  it("distinguishes no telemetry from reported zero and fills UTC daily buckets", () => {
    const empty = getCostStats(root, 7, now);
    expect(empty.daily).toHaveLength(7);
    expect(empty.daily[0].date).toBe("2026-09-03");
    expect(empty.today).toMatchObject({ totalCostUsd: null, runs: 0, trackedRuns: 0 });
    seed("job", "unknown", now.toISOString(), null);
    seed("job", "zero", now.toISOString(), 0);
    expect(getCostStats(root, 7, now).today).toMatchObject({ totalCostUsd: 0, runs: 2, trackedRuns: 1, completeRuns: 1, averageCostUsd: 0 });
  });

  it("rolls up every retained run (beyond the runs API page limit), including failed and removed jobs", () => {
    for (let index = 0; index < 55; index++) seed("removed-job", `run-${index}`, now.toISOString(), 0.1);
    seed("job", "older", "2026-08-01T12:00:00Z", 2);
    seed("job", "midnight", "2026-09-09T01:00:00+02:00", 1, false);
    seed("job", "month", "2026-09-01T00:00:00Z", 3);
    seed("job", "future", "2026-09-10T00:00:00Z", 99);
    const stats = getCostStats(root, 7, now);
    expect(stats.today.totalCostUsd).toBe(5.5);
    expect(stats.period).toMatchObject({ totalCostUsd: 6.5, runs: 56, completeRuns: 55 });
    expect(stats.month.totalCostUsd).toBe(9.5);
    expect(stats.retained.totalCostUsd).toBe(11.5);
    expect(stats.jobs.map((job) => job.jobId)).toEqual(["removed-job", "job"]);
    expect(getRetainedJobCosts(root, now).get("job")?.totalCostUsd).toBe(6);
  });

  it("does not count latest symlinks, corrupt records, or symlinked external run folders", () => {
    seed("job", "real", now.toISOString(), 1);
    fs.symlinkSync("real", getRunDir(root, "job", "latest"));
    fs.symlinkSync("real", getRunDir(root, "job", "duplicate"));
    seed("job", "bad-date", "not a date", 900);
    fs.mkdirSync(getRunDir(root, "job", "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(getRunDir(root, "job", "corrupt"), "meta.json"), "null");
    expect(getCostStats(root, 30, now).retained).toMatchObject({ totalCostUsd: 1, runs: 1 });
  });

  it("does not retain pruned costs or permanently cache an evaluator still running", () => {
    seed("job", "run", now.toISOString(), 1, false);
    expect(getCostStats(root, 7, now).today.completeRuns).toBe(0);
    seed("job", "run", now.toISOString(), 1, true);
    expect(getCostStats(root, 7, now).today.completeRuns).toBe(1);
    fs.rmSync(getRunDir(root, "job", "run"), { recursive: true });
    expect(getCostStats(root, 7, now).today.runs).toBe(0);
  });
});
