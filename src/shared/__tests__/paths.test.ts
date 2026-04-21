import { describe, it, expect } from "vitest";
import { getRunDir, getJobDir, getLogPath, getStatusPath, getMetaPath, getDaemonJsonPath, getStatsPath } from "@shared/paths";
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
