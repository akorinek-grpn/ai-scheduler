import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCostStats, getRetainedJobCosts } from "../cost-stats";
import {
  CostTracker,
  writeRunCost,
  writeEvaluationCost,
  writeRunDecision,
} from "../costs";
import { getEvalPath, getLogPath, getRunDir } from "@shared/paths";
import { readRunSummary } from "../run-history";
import { pruneOldRuns } from "../pruner";
import { writeActivityRecord } from "../activity-store";
import { backfillActivityHistory } from "../stats";

let root: string;
const now = new Date("2026-09-09T12:00:00Z");
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-cost-stats-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(
  jobId: string,
  runId: string,
  startedAt: string,
  cost: number | null,
  evaluated = true,
): void {
  const directory = getRunDir(root, jobId, runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "meta.json"),
    JSON.stringify({
      jobId,
      runId,
      jobConfig: { name: jobId, directory: "/tmp" },
      trigger: "manual",
      startedAt,
    }),
  );
  fs.writeFileSync(
    path.join(directory, "status.json"),
    JSON.stringify({
      status: "failed",
      exitCode: 1,
      startedAt,
      finishedAt: startedAt,
    }),
  );
  if (cost !== null) {
    const tracker = new CostTracker("claude", 1);
    tracker.consume(JSON.stringify({ type: "result", total_cost_usd: cost }));
    writeRunCost(root, jobId, runId, [tracker.snapshot()]);
    if (evaluated) {
      const evaluator = new CostTracker("claude", 1);
      evaluator.consume('{"type":"result","total_cost_usd":0}');
      writeEvaluationCost(
        root,
        jobId,
        runId,
        "complete",
        evaluator.snapshot().entries[0],
      );
    }
  }
}

describe("cost aggregation", () => {
  it("preserves an explicitly reported script model without requiring token counts", () => {
    seed("script", "run", now.toISOString(), null);
    const tracker = new CostTracker("script", 1);
    tracker.consume(
      JSON.stringify({
        type: "scheduler_cost",
        id: "task",
        currency: "USD",
        cost_usd: 0.25,
        model: "task-model",
      }),
    );
    tracker.consume('{"type":"scheduler_cost_complete"}');
    writeRunCost(root, "script", "run", [tracker.snapshot()]);
    expect(getCostStats(root, 7, now).period.executionModels).toEqual([
      "task-model",
    ]);
    expect(
      readRunSummary(root, "script", "run")?.cost?.attempts[0].entries[0]
        .tokens,
    ).toBeNull();
  });

  it("rolls up only reported execution models within each period and retained job history", () => {
    seed("job", "current", now.toISOString(), 1);
    seed("job", "old", "2026-08-01T12:00:00Z", 1);
    const report = (model: string): string =>
      JSON.stringify({
        type: "result",
        total_cost_usd: 1,
        modelUsage: {
          [model]: { inputTokens: 100, outputTokens: 20, costUSD: 1 },
        },
      });
    const current = new CostTracker("claude", 1);
    current.consume(report("claude-sonnet-4-6"));
    writeRunCost(root, "job", "current", [
      current.snapshot(),
      { ...current.snapshot(), attempt: 2 },
    ]);
    const old = new CostTracker("claude", 1);
    old.consume(report("claude-opus-4-6"));
    writeRunCost(root, "job", "old", [old.snapshot()]);
    const evaluator = new CostTracker("claude", 1);
    evaluator.consume(report("claude-haiku-4-5"));
    writeEvaluationCost(
      root,
      "job",
      "current",
      "complete",
      evaluator.snapshot().entries[0],
    );

    const stats = getCostStats(root, 7, now);
    expect(stats.period.executionModels).toEqual(["claude-sonnet-4-6"]);
    expect(stats.jobs[0].executionModels).toEqual(["claude-sonnet-4-6"]);
    expect(stats.retained.executionModels).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    expect(getRetainedJobCosts(root, now).get("job")?.executionModels).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
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
    expect(
      readRunSummary(root, "job", "legacy")?.configuredModel,
    ).toBeUndefined();
  });

  it("distinguishes no telemetry from reported zero and fills UTC daily buckets", () => {
    const empty = getCostStats(root, 7, now);
    expect(empty.daily).toHaveLength(7);
    expect(empty.daily[0].date).toBe("2026-09-03");
    expect(empty.today).toMatchObject({
      totalCostUsd: null,
      runs: 0,
      trackedRuns: 0,
    });
    seed("job", "unknown", now.toISOString(), null);
    seed("job", "zero", now.toISOString(), 0);
    expect(getCostStats(root, 7, now).today).toMatchObject({
      totalCostUsd: 0,
      runs: 2,
      trackedRuns: 1,
      completeRuns: 1,
      averageCostUsd: 0,
    });
  });

  it("rolls up every retained run (beyond the runs API page limit), including failed and removed jobs", () => {
    for (let index = 0; index < 55; index++)
      seed("removed-job", `run-${index}`, now.toISOString(), 0.1);
    seed("job", "older", "2026-08-01T12:00:00Z", 2);
    seed("job", "midnight", "2026-09-09T01:00:00+02:00", 1, false);
    seed("job", "month", "2026-09-01T00:00:00Z", 3);
    seed("job", "future", "2026-09-10T00:00:00Z", 99);
    const stats = getCostStats(root, 7, now);
    expect(stats.today.totalCostUsd).toBe(5.5);
    expect(stats.period).toMatchObject({
      totalCostUsd: 6.5,
      runs: 56,
      completeRuns: 55,
    });
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
    fs.writeFileSync(
      path.join(getRunDir(root, "job", "corrupt"), "meta.json"),
      "null",
    );
    expect(getCostStats(root, 30, now).retained).toMatchObject({
      totalCostUsd: 1,
      runs: 1,
    });
  });

  it("does not retain pruned costs or permanently cache an evaluator still running", () => {
    seed("job", "run", now.toISOString(), 1, false);
    expect(getCostStats(root, 7, now).today.completeRuns).toBe(0);
    seed("job", "run", now.toISOString(), 1, true);
    expect(getCostStats(root, 7, now).today.completeRuns).toBe(1);
    fs.rmSync(getRunDir(root, "job", "run"), { recursive: true });
    expect(getCostStats(root, 7, now).today.runs).toBe(0);
  });

  it("keeps the cost, Jev decision and verdict of a pruned run", () => {
    seed("job", "a-old", "2026-09-08T12:00:00Z", 2);
    seed("job", "b-new", now.toISOString(), 1);
    for (const runId of ["a-old", "b-new"])
      fs.writeFileSync(getLogPath(root, "job", runId), "");
    fs.writeFileSync(
      getEvalPath(root, "job", "a-old"),
      JSON.stringify({
        summary: "s",
        severity: "ok",
        followUpNeeded: false,
        followUpReason: null,
        evaluatedAt: now.toISOString(),
        source: "haiku",
      }),
    );
    writeRunDecision(root, "job", "a-old", {
      version: 1,
      mode: "shadow",
      state: "complete",
      error: null,
      updatedAt: now.toISOString(),
      usage: {
        requests: 1,
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.0003,
        model: "typesafe/jev-1.13-20260917",
      },
      decision: {
        model: "typesafe/jev-1.13-20260917",
        requestId: null,
        provider: "TypeSafe",
        latencyMs: 400,
        severity: {
          label: "ok",
          score: 0,
          confidence: 0.9,
          probabilities: { ok: 0.9, info: 0, warning: 0.1, critical: 0 },
        },
        followUp: { probability: 0.1, needed: false },
        failureKind: {
          choice: "none",
          confidence: 0.5,
          probabilities: { none: 1 },
        },
        evaluatedAt: now.toISOString(),
      },
    });
    const before = getCostStats(root, 7, now);
    // Records written for runs still on disk must not be counted a second time.
    backfillActivityHistory(root);
    expect(getCostStats(root, 7, now)).toEqual(before);

    pruneOldRuns(root, "job", 1);
    expect(fs.existsSync(getRunDir(root, "job", "a-old"))).toBe(false);
    const after = getCostStats(root, 7, now);
    expect(after).toEqual(before);
    expect(after.daily.find((day) => day.date === "2026-09-08")).toMatchObject({
      totalCostUsd: 2.0003,
      runs: 1,
      trackedRuns: 1,
      completeRuns: 1,
      decisionRequests: 1,
      decisionCompared: 1,
      decisionSeverityAgreed: 1,
    });
    expect(after.jobs).toMatchObject([
      { jobId: "job", jobName: "job", runs: 2 },
    ]);
    expect(getRetainedJobCosts(root, now).get("job")).toMatchObject({
      totalCostUsd: 3.0003,
      runs: 2,
      trackedRuns: 2,
    });
  });

  it("counts a run pruned before its cost was preserved as not reporting", () => {
    seed("job", "kept", now.toISOString(), 1);
    const legacy = (jobId: string, runId: string) =>
      writeActivityRecord(root, {
        version: 1,
        jobId,
        runId,
        startedAt: now.toISOString(),
        stats: { toolCalls: 0, toolsByName: {}, isAiSession: true },
      });
    legacy("job", "pruned-earlier");
    legacy("removed-job", "pruned-earlier");
    const stats = getCostStats(root, 7, now);
    expect(stats.today).toMatchObject({
      totalCostUsd: 1,
      runs: 3,
      trackedRuns: 1,
      completeRuns: 1,
    });
    expect(stats.jobs.find((job) => job.jobId === "removed-job")).toMatchObject(
      {
        jobName: "removed-job",
        runs: 1,
        trackedRuns: 0,
        totalCostUsd: null,
      },
    );
  });

  it("still prunes a run whose evaluation file is unreadable", () => {
    seed("job", "a-old", now.toISOString(), 2);
    seed("job", "b-new", now.toISOString(), 1);
    for (const runId of ["a-old", "b-new"])
      fs.writeFileSync(getLogPath(root, "job", runId), "");
    fs.writeFileSync(getEvalPath(root, "job", "a-old"), "{broken");
    pruneOldRuns(root, "job", 1);
    expect(fs.existsSync(getRunDir(root, "job", "a-old"))).toBe(false);
    expect(getCostStats(root, 7, now).today).toMatchObject({
      totalCostUsd: 3,
      runs: 2,
    });
  });

  it("rolls up Jev decision requests, input tokens and spend as a separate metric per period and job", () => {
    seed("job", "a", now.toISOString(), 1);
    seed("job", "b", now.toISOString(), 1);
    seed("job", "old", "2026-08-01T12:00:00Z", 1);
    seed("other", "c", now.toISOString(), null);
    const decided = (
      jobId: string,
      runId: string,
      costUsd: number | null,
      inputTokens: number,
    ) =>
      writeRunDecision(root, jobId, runId, {
        version: 1,
        mode: "shadow",
        state: "complete",
        error: null,
        updatedAt: now.toISOString(),
        decision: null,
        usage: {
          requests: 1,
          inputTokens,
          outputTokens: 100,
          costUsd,
          model: "typesafe/jev-1.13-20260917",
        },
      });
    decided("job", "a", 0.0003, 8000);
    decided("job", "b", 0.0002, 5000);
    decided("job", "old", 0.0001, 1000);
    decided("other", "c", null, 700); // usage known, spend unavailable, no other cost reporting
    const stats = getCostStats(root, 7, now);
    // today: a (8000, $0.0003), b (5000, $0.0002), c (700, no cost); retained adds old (1000, $0.0001)
    expect(stats.today).toMatchObject({
      decisionRequests: 3,
      decisionInputTokens: 13700,
      decisionCostUsd: 0.0005,
    });
    expect(stats.retained).toMatchObject({
      decisionRequests: 4,
      decisionInputTokens: 14700,
      decisionCostUsd: 0.0006,
    });
    expect(stats.today.totalCostUsd).toBe(2.0005);
    expect(stats.jobs.find((job) => job.jobId === "job")).toMatchObject({
      decisionRequests: 2,
      decisionCostUsd: 0.0005,
    });
    expect(stats.jobs.find((job) => job.jobId === "other")).toMatchObject({
      decisionRequests: 1,
      decisionInputTokens: 700,
      decisionCostUsd: null,
      totalCostUsd: null,
    });
    expect(getRetainedJobCosts(root, now).get("job")).toMatchObject({
      decisionRequests: 3,
    });
    expect(getCostStats(root, 7, now).daily.at(-1)).toMatchObject({
      decisionRequests: 3,
    });
  });

  it("estimates Jev savings against Haiku and counts agreement, skipped Haiku calls and the baseline", () => {
    const haiku = (
      jobId: string,
      runId: string,
      costUsd: number,
      severity: string,
      followUpNeeded: boolean,
      source: string,
    ) => {
      writeEvaluationCost(root, jobId, runId, "complete", {
        id: "claude",
        label: "Claude session",
        source: "claude",
        costUsd,
        tokens: null,
        models: [],
      });
      fs.writeFileSync(
        path.join(getRunDir(root, jobId, runId), "evaluation.json"),
        JSON.stringify({
          summary: "s",
          severity,
          followUpNeeded,
          followUpReason: null,
          evaluatedAt: now.toISOString(),
          source,
        }),
      );
    };
    const jev = (
      jobId: string,
      runId: string,
      mode: "shadow" | "enforce",
      severity: "ok" | "warning",
      followUp: number,
      costUsd: number,
    ) =>
      writeRunDecision(root, jobId, runId, {
        version: 1,
        mode,
        state: "complete",
        error: null,
        updatedAt: now.toISOString(),
        usage: {
          requests: 1,
          inputTokens: 1000,
          outputTokens: 100,
          costUsd,
          model: "typesafe/jev-1.13-20260917",
        },
        decision: {
          model: "typesafe/jev-1.13-20260917",
          requestId: null,
          provider: "TypeSafe",
          latencyMs: 400,
          severity: {
            label: severity,
            score: 0,
            confidence: 0.9,
            probabilities: {
              ok: severity === "ok" ? 0.9 : 0.1,
              info: 0,
              warning: severity === "ok" ? 0.1 : 0.9,
              critical: 0,
            },
          },
          followUp: { probability: followUp, needed: followUp >= 0.5 },
          failureKind: {
            choice: "none",
            confidence: 0.5,
            probabilities: { none: 1 },
          },
          evaluatedAt: now.toISOString(),
        },
      });
    // Baseline runs: Haiku only, $0.10 and $0.06 -> average $0.08.
    seed("job", "h1", now.toISOString(), 1, false);
    haiku("job", "h1", 0.1, "ok", false, "haiku");
    seed("job", "h2", now.toISOString(), 1, false);
    haiku("job", "h2", 0.06, "ok", false, "haiku");
    // Shadow, Jev judged clean and agreed: enforce would have skipped the $0.08 Haiku call -> saves 0.08 - 0.0003.
    seed("job", "s1", now.toISOString(), 1, false);
    haiku("job", "s1", 0.08, "ok", false, "haiku");
    jev("job", "s1", "shadow", "ok", 0.1, 0.0003);
    // Shadow, Jev says warning + follow-up while Haiku said ok: Haiku would still run -> Jev is overhead (-0.0003), disagreement.
    seed("job", "s2", now.toISOString(), 1, false);
    haiku("job", "s2", 0.08, "ok", false, "haiku");
    jev("job", "s2", "shadow", "warning", 0.9, 0.0003);
    // Enforce, Haiku skipped: baseline 0.08 - 0.0002.
    seed("job", "e1", now.toISOString(), 1, false);
    writeEvaluationCost(root, "job", "e1", "complete", null);
    fs.writeFileSync(
      path.join(getRunDir(root, "job", "e1"), "evaluation.json"),
      JSON.stringify({
        summary: "s",
        severity: "ok",
        followUpNeeded: false,
        followUpReason: null,
        evaluatedAt: now.toISOString(),
        source: "jev",
      }),
    );
    jev("job", "e1", "enforce", "ok", 0.1, 0.0002);
    // Enforce with a Haiku summary: Haiku ran anyway -> -0.0002, no agreement count (Haiku's verdict was not used).
    seed("job", "e2", now.toISOString(), 1, false);
    haiku("job", "e2", 0.08, "warning", true, "jev+haiku");
    jev("job", "e2", "enforce", "warning", 0.9, 0.0002);

    const stats = getCostStats(root, 7, now);
    expect(stats.baselineHaikuEvaluationCostUsd).toBeCloseTo(0.08, 10);
    expect(stats.baselineHaikuEvaluations).toBe(4); // h1, h2, s1, s2 (e2's Haiku call only wrote a summary)
    expect(stats.today.decisionSavingsUsd).toBeCloseTo(
      0.0797 - 0.0003 + 0.0798 - 0.0002,
      10,
    );
    expect(stats.today).toMatchObject({
      decisionRequests: 4,
      decisionHaikuSkipped: 1,
      decisionCompared: 2,
      decisionSeverityAgreed: 1,
      decisionFollowUpAgreed: 1,
    });
    expect(getRetainedJobCosts(root, now).get("job")).toMatchObject({
      decisionHaikuSkipped: 1,
      decisionCompared: 2,
    });
    expect(stats.today.decisionSavingsUsd).toBe(
      stats.period.decisionSavingsUsd,
    );
  });

  it("counts benchmark runs (Haiku judged every run) as compared, and their Haiku calls as baseline evaluations", () => {
    const benchmark = (
      runId: string,
      haikuSeverity: string,
      haikuFollowUp: boolean,
    ) => {
      seed("job", runId, now.toISOString(), 1, false);
      writeEvaluationCost(root, "job", runId, "complete", {
        id: "claude",
        label: "Claude session",
        source: "claude",
        costUsd: 0.08,
        tokens: null,
        models: [],
      });
      fs.writeFileSync(
        path.join(getRunDir(root, "job", runId), "evaluation.json"),
        JSON.stringify({
          summary: "s",
          severity: "ok",
          followUpNeeded: false,
          followUpReason: null,
          evaluatedAt: now.toISOString(),
          source: "jev+haiku",
          haikuBenchmark: {
            severity: haikuSeverity,
            followUpNeeded: haikuFollowUp,
          },
        }),
      );
      writeRunDecision(root, "job", runId, {
        version: 1,
        mode: "benchmark",
        state: "complete",
        error: null,
        updatedAt: now.toISOString(),
        usage: {
          requests: 1,
          inputTokens: 1000,
          outputTokens: 100,
          costUsd: 0.0002,
          model: "typesafe/jev-1.13-20260917",
        },
        decision: {
          model: "typesafe/jev-1.13-20260917",
          requestId: null,
          provider: "TypeSafe",
          latencyMs: 400,
          severity: {
            label: "ok",
            score: 0,
            confidence: 0.9,
            probabilities: { ok: 0.9, info: 0.1, warning: 0, critical: 0 },
          },
          followUp: { probability: 0.1, needed: false },
          failureKind: {
            choice: "none",
            confidence: 0.5,
            probabilities: { none: 1 },
          },
          evaluatedAt: now.toISOString(),
        },
      });
    };
    benchmark("b1", "ok", false); // agrees with Jev
    benchmark("b2", "warning", true); // disagrees on both
    const stats = getCostStats(root, 7, now);
    expect(stats.today).toMatchObject({
      decisionRequests: 2,
      decisionHaikuSkipped: 0,
      decisionCompared: 2,
      decisionSeverityAgreed: 1,
      decisionFollowUpAgreed: 1,
    });
    // Haiku ran on every benchmark run, so Jev saved nothing there.
    expect(stats.today.decisionSavingsUsd).toBeCloseTo(-0.0004, 10);
    expect(stats.baselineHaikuEvaluations).toBe(2);

    // A pruned benchmark run keeps Haiku's verdict, so it still counts as a comparison.
    for (const runId of ["b1", "b2"])
      fs.writeFileSync(getLogPath(root, "job", runId), "");
    backfillActivityHistory(root);
    pruneOldRuns(root, "job", 1);
    expect(
      ["b1", "b2"].filter((runId) =>
        fs.existsSync(getRunDir(root, "job", runId)),
      ),
    ).toHaveLength(1);
    expect(getCostStats(root, 7, now).today).toMatchObject({
      decisionCompared: 2,
      decisionSeverityAgreed: 1,
      decisionFollowUpAgreed: 1,
    });
  });
});
