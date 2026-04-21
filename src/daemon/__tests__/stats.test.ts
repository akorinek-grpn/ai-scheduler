import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getOrBackfillRunStats } from "../stats";
import { getStatsPath, getLogPath, getMetaPath, getRunDir } from "@shared/paths";
import type { RunMeta } from "@shared/types";

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
