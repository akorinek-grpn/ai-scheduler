import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getOrBackfillRunStats, getActivityStats } from "../stats";
import { getStatsPath, getLogPath, getMetaPath, getRunDir, getStatusPath } from "@shared/paths";
import type { RunMeta, RunStats, RunStatusFile } from "@shared/types";

describe("getOrBackfillRunStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-stats-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeLegacyRun = (jobId: string, runId: string, logContent: string, type: "claude" | "script"): void => {
    const runDir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(getLogPath(tmpDir, jobId, runId), logContent);

    const meta: RunMeta = {
      jobId,
      runId,
      trigger: "scheduled",
      startedAt: new Date().toISOString(),
      jobConfig: {
        name: jobId,
        schedule: "* * * * *",
        directory: "/tmp",
        type,
        enabled: true,
        tags: [],
      },
    };
    fs.writeFileSync(getMetaPath(tmpDir, jobId, runId), JSON.stringify(meta));
  };

  it("returns existing stats.json without touching the log", () => {
    writeLegacyRun("j", "r1", "irrelevant", "claude");
    const prewritten = { toolCalls: 99, toolsByName: { Custom: 99 }, isAiSession: true };
    fs.writeFileSync(getStatsPath(tmpDir, "j", "r1"), JSON.stringify(prewritten));

    const stats = getOrBackfillRunStats(tmpDir, "j", "r1");
    expect(stats).toEqual(prewritten);
  });

  it("backfills tool counts from output.log markers for AI sessions", () => {
    const log = [
      "",
      "> [Bash] $ ls",
      "output line",
      "> [Read] Reading /tmp/x",
      "> [Bash] $ pwd",
      "",
    ].join("\n");
    writeLegacyRun("j", "r2", log, "claude");

    const stats = getOrBackfillRunStats(tmpDir, "j", "r2");
    expect(stats).toEqual({
      toolCalls: 3,
      toolsByName: { Bash: 2, Read: 1 },
      isAiSession: true,
    });

    // Persists the backfilled file.
    const persisted = JSON.parse(fs.readFileSync(getStatsPath(tmpDir, "j", "r2"), "utf-8"));
    expect(persisted).toEqual(stats);
  });

  it("returns zeros for script jobs without parsing", () => {
    writeLegacyRun("j", "r3", "> [something] from shell output\n", "script");

    const stats = getOrBackfillRunStats(tmpDir, "j", "r3");
    expect(stats).toEqual({
      toolCalls: 0,
      toolsByName: {},
      isAiSession: false,
    });
  });

  it("returns null when meta.json is missing", () => {
    const stats = getOrBackfillRunStats(tmpDir, "j", "missing");
    expect(stats).toBeNull();
  });
});

describe("getActivityStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-agg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const seedRun = (jobId: string, runId: string, startedAt: string, type: "claude" | "script", stats?: Partial<RunStats>): void => {
    const runDir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = {
      jobId, runId, trigger: "scheduled", startedAt,
      jobConfig: { name: jobId, schedule: "* * * * *", directory: "/tmp", type, enabled: true, tags: [] },
    };
    fs.writeFileSync(getMetaPath(tmpDir, jobId, runId), JSON.stringify(meta));
    const status: RunStatusFile = { status: "success", exitCode: 0, startedAt, finishedAt: startedAt };
    fs.writeFileSync(getStatusPath(tmpDir, jobId, runId), JSON.stringify(status));
    fs.writeFileSync(getLogPath(tmpDir, jobId, runId), "");
    if (stats) {
      fs.writeFileSync(getStatsPath(tmpDir, jobId, runId), JSON.stringify({
        toolCalls: 0, toolsByName: {}, isAiSession: type === "claude", ...stats,
      }));
    }
  };

  it("aggregates AI sessions only, ignoring script runs", () => {
    seedRun("ai", "r1", "2026-04-18T10:00:00Z", "claude", { toolCalls: 5, toolsByName: { Bash: 3, Read: 2 }, isAiSession: true });
    seedRun("ai", "r2", "2026-04-19T09:00:00Z", "claude", { toolCalls: 2, toolsByName: { Edit: 2 }, isAiSession: true });
    seedRun("sh", "r3", "2026-04-19T09:00:00Z", "script", { toolCalls: 0, toolsByName: {}, isAiSession: false });

    const result = getActivityStats(tmpDir, 30);
    expect(result.lifetime.sessions).toBe(2);
    expect(result.lifetime.toolCalls).toBe(7);
    expect(result.lifetime.toolsByName).toEqual({ Bash: 3, Read: 2, Edit: 2 });
  });

  it("bucketizes daily counts for the requested window", () => {
    const today = new Date();
    const dayStr = (d: Date): string => d.toISOString().slice(0, 10);

    const d0 = new Date(today); d0.setHours(12, 0, 0, 0);
    const d1 = new Date(today); d1.setDate(d1.getDate() - 1); d1.setHours(12, 0, 0, 0);
    const d5 = new Date(today); d5.setDate(d5.getDate() - 5); d5.setHours(12, 0, 0, 0);
    const d100 = new Date(today); d100.setDate(d100.getDate() - 100); d100.setHours(12, 0, 0, 0);

    seedRun("ai", "a", d0.toISOString(), "claude", { toolCalls: 1, toolsByName: { Bash: 1 }, isAiSession: true });
    seedRun("ai", "b", d1.toISOString(), "claude", { toolCalls: 2, toolsByName: { Bash: 2 }, isAiSession: true });
    seedRun("ai", "c", d5.toISOString(), "claude", { toolCalls: 4, toolsByName: { Read: 4 }, isAiSession: true });
    seedRun("ai", "d", d100.toISOString(), "claude", { toolCalls: 9, toolsByName: { Read: 9 }, isAiSession: true });

    const result = getActivityStats(tmpDir, 30);

    expect(result.daily.length).toBe(30);
    const today0 = result.daily.find((b) => b.date === dayStr(d0));
    expect(today0).toEqual({ date: dayStr(d0), sessions: 1, toolCalls: 1 });
    const yest = result.daily.find((b) => b.date === dayStr(d1));
    expect(yest).toEqual({ date: dayStr(d1), sessions: 1, toolCalls: 2 });

    // Run from 100 days ago must NOT appear in daily, but DOES count in lifetime.
    expect(result.lifetime.sessions).toBe(4);
    expect(result.lifetime.toolCalls).toBe(16);
  });

  it("returns empty buckets when no runs exist", () => {
    const result = getActivityStats(tmpDir, 7);
    expect(result.lifetime.sessions).toBe(0);
    expect(result.lifetime.toolCalls).toBe(0);
    expect(result.daily.length).toBe(7);
    expect(result.daily.every((b) => b.sessions === 0 && b.toolCalls === 0)).toBe(true);
  });
});
