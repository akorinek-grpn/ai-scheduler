import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActivityRecordPath, getLogPath, getMetaPath, getRunDir, getRunsDir, getStatsPath, getStatusPath } from "@shared/paths";
import type { JobConfig, RunMeta, RunStats, RunStatusFile } from "@shared/types";
import { runJob } from "../job-runner";
import { pruneOldRuns } from "../pruner";
import { backfillActivityHistory, discardProvisionalRunStats, getActivityStats, getOrBackfillRunStats } from "../stats";

let root: string;
const startedAt = "2026-09-09T10:00:00.000Z";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-activity-retention-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T09:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedRun(jobId: string, runId: string, toolsByName: Record<string, number>, options: {
  startedAt?: string;
  type?: "claude" | "script";
  status?: RunStatusFile["status"];
} = {}): void {
  const jobConfig: JobConfig = {
    name: jobId, schedule: "0 0 * * *", directory: root,
    type: options.type ?? "claude", enabled: false, tags: [],
  };
  const meta: RunMeta = { jobId, runId, jobConfig, trigger: "scheduled", startedAt: options.startedAt ?? startedAt };
  const status: RunStatusFile = {
    status: options.status ?? "success", exitCode: 0, startedAt: meta.startedAt, finishedAt: meta.startedAt,
  };
  const stats: RunStats = {
    toolCalls: Object.values(toolsByName).reduce((total, count) => total + count, 0),
    toolsByName, isAiSession: jobConfig.type === "claude",
  };
  fs.mkdirSync(getRunDir(root, jobId, runId), { recursive: true });
  fs.writeFileSync(getMetaPath(root, jobId, runId), JSON.stringify(meta));
  fs.writeFileSync(getStatusPath(root, jobId, runId), JSON.stringify(status));
  fs.writeFileSync(getStatsPath(root, jobId, runId), JSON.stringify(stats));
  fs.writeFileSync(getLogPath(root, jobId, runId), "");
}

describe("durable activity history", () => {
  it("imports existing completed history without an API read", () => {
    seedRun("job", "run", { Bash: 2 });
    backfillActivityHistory(root);
    backfillActivityHistory(root);
    fs.rmSync(getRunsDir(root), { recursive: true });
    expect(getActivityStats(root, 30).lifetime).toEqual({ sessions: 1, toolCalls: 2, toolsByName: { Bash: 2 } });
  });

  it("preserves lifetime totals, top tools and UTC daily buckets after pruning and restart", async () => {
    seedRun("job", "old", { Bash: 4, Read: 1 });
    seedRun("job", "recent", { Edit: 2 }, { startedAt: "2026-09-10T00:30:00+02:00" });
    seedRun("other", "old", { Read: 3 }, { startedAt: "2026-01-01T10:00:00Z" });
    const before = getActivityStats(root, 30);
    expect(before.lifetime).toEqual({ sessions: 3, toolCalls: 10, toolsByName: { Bash: 4, Read: 4, Edit: 2 } });
    expect(before.daily.find((bucket) => bucket.date === "2026-09-09")).toEqual({ date: "2026-09-09", sessions: 2, toolCalls: 7 });
    pruneOldRuns(root, "job", 1);
    pruneOldRuns(root, "other", 0);
    expect(fs.existsSync(getRunDir(root, "job", "old"))).toBe(false);
    fs.rmSync(getRunsDir(root), { recursive: true });
    vi.resetModules();
    const restarted = await import("../stats");
    expect(restarted.getActivityStats(root, 30)).toEqual(before);
    expect(restarted.getActivityStats(root, 7).lifetime).toEqual(before.lifetime);
  });

  it("archives before deleting even when the dashboard has never been opened", () => {
    seedRun("job", "old", { Bash: 5 });
    seedRun("job", "recent", { Read: 1 });
    pruneOldRuns(root, "job", 1);
    expect(fs.existsSync(getRunDir(root, "job", "old"))).toBe(false);
    expect(getActivityStats(root, 30).lifetime).toEqual({ sessions: 2, toolCalls: 6, toolsByName: { Bash: 5, Read: 1 } });
  });

  it("seeds retained legacy stats once and never counts the latest symlink twice", () => {
    seedRun("job", "old", {});
    fs.unlinkSync(getStatsPath(root, "job", "old"));
    fs.writeFileSync(getLogPath(root, "job", "old"), "> [Bash] pwd\n> [Read] file\n");
    fs.symlinkSync("old", path.join(getRunDir(root, "job", "old"), "..", "latest"));
    const before = getActivityStats(root, 30);
    expect(before.lifetime).toEqual({ sessions: 1, toolCalls: 2, toolsByName: { Bash: 1, Read: 1 } });
    expect(getActivityStats(root, 30)).toEqual(before);
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30)).toEqual(before);
  });

  it("keeps failed AI runs but does not turn script jobs into AI sessions", () => {
    seedRun("job", "failed", {}, { status: "failed" });
    seedRun("script", "old", {}, { type: "script" });
    pruneOldRuns(root, "job", 0);
    pruneOldRuns(root, "script", 0);
    expect(getActivityStats(root, 30).lifetime).toEqual({ sessions: 1, toolCalls: 0, toolsByName: {} });
  });

  it("replaces a provisional run count with its final stats without double-counting", () => {
    seedRun("job", "run", { Bash: 1 }, { status: "running" });
    fs.writeFileSync(getLogPath(root, "job", "run"), "> [Bash] pwd\n");
    expect(getActivityStats(root, 30).lifetime.toolCalls).toBe(1);
    seedRun("job", "run", { Bash: 4, Read: 2 });
    const final = getActivityStats(root, 30);
    expect(final.lifetime).toEqual({ sessions: 1, toolCalls: 6, toolsByName: { Bash: 4, Read: 2 } });
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30)).toEqual(final);
  });

  it("does not delete running or unreadable runs", () => {
    seedRun("job", "running", { Bash: 1 }, { status: "running" });
    seedRun("job", "broken", { Bash: 2 });
    fs.writeFileSync(getMetaPath(root, "job", "broken"), "broken json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneOldRuns(root, "job", 0);
    expect(fs.existsSync(getRunDir(root, "job", "running"))).toBe(true);
    expect(fs.existsSync(getRunDir(root, "job", "broken"))).toBe(true);
  });

  it("does not archive zero or delete an AI run when both stats and log are unavailable", () => {
    seedRun("job", "broken", { Bash: 2 });
    fs.writeFileSync(getStatsPath(root, "job", "broken"), "broken json");
    fs.unlinkSync(getLogPath(root, "job", "broken"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pruneOldRuns(root, "job", 0);
    expect(fs.existsSync(getRunDir(root, "job", "broken"))).toBe(true);
    expect(fs.existsSync(getActivityRecordPath(root, "job", "broken"))).toBe(false);
  });

  it.each(["missing", "truncated"])("does not overwrite a preserved count when native stats are corrupt and the log is %s", (damage) => {
    seedRun("job", "run", { Bash: 2 });
    const before = getActivityStats(root, 30);
    fs.writeFileSync(getStatsPath(root, "job", "run"), "broken json");
    if (damage === "missing") fs.unlinkSync(getLogPath(root, "job", "run"));
    else fs.writeFileSync(getLogPath(root, "job", "run"), "");
    expect(getActivityStats(root, 30)).toEqual(before);
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30)).toEqual(before);
  });

  it("does not save provisional log counts or freeze them between activity reads", () => {
    seedRun("job", "running", {}, { status: "running" });
    fs.unlinkSync(getStatsPath(root, "job", "running"));
    fs.writeFileSync(getLogPath(root, "job", "running"), "> [Bash] pwd\n");
    expect(getActivityStats(root, 30).lifetime.toolCalls).toBe(1);
    expect(fs.existsSync(getStatsPath(root, "job", "running"))).toBe(false);
    expect(fs.existsSync(getActivityRecordPath(root, "job", "running"))).toBe(false);
    fs.appendFileSync(getLogPath(root, "job", "running"), "> [Read] file\n");
    expect(getActivityStats(root, 30).lifetime.toolCalls).toBe(2);
  });

  it("discards an old provisional stats cache on orphan recovery before preserving the completed log", () => {
    seedRun("job", "orphan", { Bash: 1 }, { status: "running" });
    fs.writeFileSync(getLogPath(root, "job", "orphan"), "> [Bash] pwd\n> [Read] file\n");
    discardProvisionalRunStats(root, "job", "orphan");
    fs.writeFileSync(getStatusPath(root, "job", "orphan"), JSON.stringify({ status: "failed" }));
    backfillActivityHistory(root);
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30).lifetime).toEqual({ sessions: 1, toolCalls: 2, toolsByName: { Bash: 1, Read: 1 } });
  });

  it("retains finalized native stats when interrupted before terminal status is written", () => {
    seedRun("job", "orphan", { Bash: 3 }, { status: "running" });
    const statsPath = getStatsPath(root, "job", "orphan");
    fs.writeFileSync(statsPath, JSON.stringify({ toolCalls: 3, toolsByName: { Bash: 3 }, isAiSession: true, finalized: true }));
    discardProvisionalRunStats(root, "job", "orphan");
    expect(getOrBackfillRunStats(root, "job", "orphan")?.toolCalls).toBe(3);
    fs.writeFileSync(getStatusPath(root, "job", "orphan"), JSON.stringify({ status: "failed" }));
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30).lifetime.toolCalls).toBe(3);
  });

  it("repairs damaged archive records from retained data but rejects unrecoverable corruption", () => {
    seedRun("job", "run", { Bash: 2 });
    const before = getActivityStats(root, 30);
    const recordPath = getActivityRecordPath(root, "job", "run");
    fs.writeFileSync(recordPath, "broken json");
    expect(getActivityStats(root, 30)).toEqual(before);
    fs.rmSync(getRunsDir(root), { recursive: true });
    fs.writeFileSync(recordPath, "broken json");
    expect(() => getActivityStats(root, 30)).toThrow("Cannot read preserved activity");
    expect(fs.readFileSync(recordPath, "utf-8")).toBe("broken json");
  });

  it("keeps the previous record if an update is interrupted and ignores temporary files", () => {
    seedRun("job", "run", { Bash: 2 });
    const before = getActivityStats(root, 30);
    seedRun("job", "run", { Bash: 4 });
    const recordPath = getActivityRecordPath(root, "job", "run");
    const content = fs.readFileSync(recordPath, "utf-8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk failure"); });
    expect(() => getActivityStats(root, 30)).toThrow("disk failure");
    expect(fs.readFileSync(recordPath, "utf-8")).toBe(content);
    rename.mockRestore();
    fs.writeFileSync(`${recordPath}.abandoned.tmp`, "incomplete JSON");
    fs.rmSync(getRunsDir(root), { recursive: true });
    expect(getActivityStats(root, 30)).toEqual(before);
  });

  it("keeps source runs when atomic archive persistence fails, then retries safely", () => {
    seedRun("job", "old", { Bash: 5 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk failure"); });
    pruneOldRuns(root, "job", 0);
    expect(fs.existsSync(getRunDir(root, "job", "old"))).toBe(true);
    expect(warn).toHaveBeenCalled();
    rename.mockRestore();
    pruneOldRuns(root, "job", 0);
    expect(fs.existsSync(getRunDir(root, "job", "old"))).toBe(false);
    expect(getActivityStats(root, 30).lifetime.toolCalls).toBe(5);
  });

  it("replaces a changed retained record rather than adding its counts again", () => {
    seedRun("job", "run", { Bash: 5 });
    getActivityStats(root, 30);
    seedRun("job", "run", { Read: 2 }, { startedAt: "2026-09-10T01:00:00Z" });
    const updated = getActivityStats(root, 30);
    expect(updated.lifetime).toEqual({ sessions: 1, toolCalls: 2, toolsByName: { Read: 2 } });
    expect(updated.daily.find((bucket) => bucket.date === "2026-09-09")?.sessions).toBe(0);
    pruneOldRuns(root, "job", 0);
    expect(getActivityStats(root, 30)).toEqual(updated);
  });
});

describe("runner activity capture", () => {
  it("persists a single run across retries without needing an API read", async () => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const retried = fs.existsSync("attempted");
fs.writeFileSync("attempted", "yes");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Bash",input:{command:"pwd"}}]}})+"\\n");
process.exitCode = retried ? 0 : 1;
`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const writes = vi.spyOn(fs, "writeFileSync");
    const job: JobConfig = { name: "Test", type: "claude", prompt: "test", schedule: "0 0 * * *", enabled: false, tags: [], directory: root };
    const run = await runJob({ jobId: "job", jobConfig: job, projectRoot: root, trigger: "manual", maxRetries: 1 });
    expect(run.status).toBe("success");
    const finalStatsIndex = writes.mock.calls.findIndex(([file, content]) => String(file).endsWith("stats.json") && String(content).includes('"finalized": true'));
    const finalStatusIndex = writes.mock.calls.findIndex(([file, content]) => String(file).endsWith("status.json") && String(content).includes('"status": "success"'));
    expect(finalStatsIndex).toBeGreaterThanOrEqual(0);
    expect(finalStatusIndex).toBeGreaterThan(finalStatsIndex);
    fs.rmSync(getRunsDir(root), { recursive: true });
    expect(getActivityStats(root, 30).lifetime).toEqual({ sessions: 1, toolCalls: 2, toolsByName: { Bash: 2 } });
  });
});
