import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pruneOldRuns } from "../pruner";
import fs from "fs";
import path from "path";
import os from "os";

describe("pruneOldRuns", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-prune-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes oldest runs when count exceeds limit", () => {
    const jobDir = path.join(tmpDir, "data", "runs", "test-job");
    for (let i = 1; i <= 5; i++) {
      const runDir = path.join(jobDir, `2026-04-0${i}T09-00-00-abc${i}23`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "meta.json"), "{}");
      fs.writeFileSync(path.join(runDir, "status.json"), "{}");
      fs.writeFileSync(path.join(runDir, "output.log"), "log");
    }

    pruneOldRuns(tmpDir, "test-job", 3);

    const remaining = fs.readdirSync(jobDir).filter((d) => d !== "latest");
    expect(remaining).toHaveLength(3);
    expect(remaining.sort()).toEqual([
      "2026-04-03T09-00-00-abc323",
      "2026-04-04T09-00-00-abc423",
      "2026-04-05T09-00-00-abc523",
    ]);
  });

  it("does nothing when count is under limit", () => {
    const jobDir = path.join(tmpDir, "data", "runs", "test-job");
    const runDir = path.join(jobDir, "2026-04-01T09-00-00-abc123");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "meta.json"), "{}");

    pruneOldRuns(tmpDir, "test-job", 5);

    const remaining = fs.readdirSync(jobDir).filter((d) => d !== "latest");
    expect(remaining).toHaveLength(1);
  });

  it("does nothing when job dir does not exist", () => {
    pruneOldRuns(tmpDir, "nonexistent-job", 5);
  });
});
