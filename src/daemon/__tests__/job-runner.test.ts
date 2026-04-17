import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runJob } from "../job-runner";
import fs from "fs";
import path from "path";
import os from "os";
import type { JobConfig, TriggerType } from "@shared/types";

describe("runJob", () => {
  let tmpDir: string;

  const testJob: JobConfig = {
    name: "Test Job",
    schedule: "0 9 * * *",
    directory: os.tmpdir(),
    prompt: "echo hello",
    enabled: true,
    tags: [],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-runner-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates run directory with meta.json and status.json", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello world"],
    });

    expect(run.runId).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    expect(fs.existsSync(path.join(runDir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "status.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "output.log"))).toBe(true);

    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
    expect(meta.jobId).toBe("test-job");
    expect(meta.trigger).toBe("manual");

    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("success");
    expect(status.exitCode).toBe(0);
  });

  it("captures command output to output.log", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "echo",
      args: ["test output line"],
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const log = fs.readFileSync(path.join(runDir, "output.log"), "utf-8");
    expect(log).toContain("test output line");
  });

  it("marks failed run with correct exit code", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "sh",
      args: ["-c", "exit 1"],
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(1);
  });

  it("marks partial run when exit code is 2", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "sh",
      args: ["-c", "echo 'FAILED: step1'; exit 2"],
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("partial");
    expect(status.exitCode).toBe(2);
  });

  it("creates latest symlink pointing to run dir", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const latestPath = path.join(tmpDir, "data", "runs", "test-job", "latest");
    expect(fs.lstatSync(latestPath).isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(latestPath);
    expect(target).toBe(run.runId);
  });

  it("times out a long-running process", async () => {
    const jobWithTimeout: JobConfig = { ...testJob, timeout: 1 };
    const run = await runJob({
      jobId: "test-job",
      jobConfig: jobWithTimeout,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "sleep",
      args: ["30"],
      defaultTimeout: 1,
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("timeout");
  }, 10000);
});
