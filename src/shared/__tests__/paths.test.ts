import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRunDir, getJobDir, getLogPath, getStatusPath, getMetaPath, getDaemonJsonPath, getStatsPath, getLatestSymlink, getNewestRunStartedAt } from "@shared/paths";
import fs from "fs";
import os from "os";
import path from "path";

const PROJECT_ROOT = "/Users/test/ai-scheduler";

describe("paths", () => {
  it("getRunDir returns correct path", () => {
    const result = getRunDir(PROJECT_ROOT, "my-job", "2026-04-08T09-00-00-abc123");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/2026-04-08T09-00-00-abc123"));
  });

  it("getJobDir returns correct path", () => {
    const result = getJobDir(PROJECT_ROOT, "my-job");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job"));
  });

  it("getLogPath returns output.log inside run dir", () => {
    const result = getLogPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/output.log"));
  });

  it("getStatusPath returns status.json inside run dir", () => {
    const result = getStatusPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/status.json"));
  });

  it("getMetaPath returns meta.json inside run dir", () => {
    const result = getMetaPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/meta.json"));
  });

  it("getDaemonJsonPath returns data/daemon.json", () => {
    const result = getDaemonJsonPath(PROJECT_ROOT);
    expect(result).toBe(path.join(PROJECT_ROOT, "data/daemon.json"));
  });

  it("getStatsPath returns data/runs/<job>/<run>/stats.json", () => {
    expect(getStatsPath("/root", "j1", "r1")).toBe("/root/data/runs/j1/r1/stats.json");
  });
});

describe("getNewestRunStartedAt", () => {
  // The missed-slot sweeps treat a slot as run once any run of the job started at or after
  // it. The `latest` symlink only moves when a run completes, so it misses a run that is
  // still going - or one a restarted daemon found orphaned (review E2E, 2026-09-28).
  let root: string;
  const run = (runId: string, startedAt: string | null, latest = false) => {
    fs.mkdirSync(getRunDir(root, "job", runId), { recursive: true });
    if (startedAt !== null) {
      fs.writeFileSync(getMetaPath(root, "job", runId), JSON.stringify({ runId, startedAt }));
    }
    if (latest) {
      fs.rmSync(getLatestSymlink(root, "job"), { force: true });
      fs.symlinkSync(runId, getLatestSymlink(root, "job"));
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-paths-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the newest run's start, even while `latest` still points at an older run", () => {
    run("2026-09-24T13-00-00-aaaaaa", "2026-09-24T13:00:00.020Z", true);
    run("2026-09-24T14-00-00-bbbbbb", "2026-09-24T14:00:00.020Z"); // running or orphaned
    run("2026-09-24T12-00-00-cccccc", "2026-09-24T12:00:00.020Z");
    expect(getNewestRunStartedAt(root, "job")).toBe("2026-09-24T14:00:00.020Z");
  });

  it("ignores entries that are not run directories", () => {
    run("2026-09-24T13-00-00-aaaaaa", "2026-09-24T13:00:00.020Z", true);
    fs.writeFileSync(path.join(getJobDir(root, "job"), ".DS_Store"), "");
    fs.mkdirSync(path.join(getJobDir(root, "job"), "zz-not-a-run"));
    expect(getNewestRunStartedAt(root, "job")).toBe("2026-09-24T13:00:00.020Z");
  });

  it("falls back to the `latest` run when the newest run has no readable meta.json", () => {
    run("2026-09-24T13-00-00-aaaaaa", "2026-09-24T13:00:00.020Z", true);
    run("2026-09-24T14-00-00-bbbbbb", null);
    expect(getNewestRunStartedAt(root, "job")).toBe("2026-09-24T13:00:00.020Z");
  });

  it("returns null for a job with no runs", () => {
    expect(getNewestRunStartedAt(root, "job")).toBeNull();
    fs.mkdirSync(getJobDir(root, "job"), { recursive: true });
    expect(getNewestRunStartedAt(root, "job")).toBeNull();
  });
});
