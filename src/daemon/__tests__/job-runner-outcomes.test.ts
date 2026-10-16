import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { classifyExit, runJob } from "../job-runner";
import { readRunCost } from "../costs";
import type { JobConfig } from "@shared/types";

// The run statuses added 2026-10-16 (plan 2 of the offload-hardening plan): a `precondition`
// that defers (exit 75) or fails the run before anything starts, `blocked` for a job's own
// "waiting on a person" exit codes, and `killed` for a process that ends on a signal.

let tmpDir: string;

const job = (extra: Partial<JobConfig> = {}): JobConfig => ({
  name: "Outcome Job",
  schedule: "0 * * * *",
  directory: os.tmpdir(),
  type: "script",
  command: "unused",
  enabled: true,
  tags: [],
  ...extra,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-outcomes-"));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const runDir = (runId: string) => path.join(tmpDir, "data", "runs", "job", runId);
const statusOf = (runId: string) =>
  JSON.parse(fs.readFileSync(path.join(runDir(runId), "status.json"), "utf8"));
const logOf = (runId: string) => fs.readFileSync(path.join(runDir(runId), "output.log"), "utf8");

describe("classifyExit", () => {
  it("names each outcome once: timeout first, then killed, success, blocked, partial, failed", () => {
    expect(classifyExit(0, true, [30])).toBe("timeout");
    expect(classifyExit(null, false)).toBe("killed");
    expect(classifyExit(0, false)).toBe("success");
    expect(classifyExit(30, false, [30])).toBe("blocked");
    expect(classifyExit(30, false)).toBe("failed");
    expect(classifyExit(2, false, [30])).toBe("partial");
    expect(classifyExit(2, false, [2])).toBe("blocked");
    expect(classifyExit(1, false, [30])).toBe("failed");
  });
});

describe("precondition", () => {
  it("exit 0 runs the job, with the check and its output in the log", async () => {
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ precondition: "echo lock is free; exit 0" }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", "echo job ran"],
    });
    expect(run.status).toBe("success");
    const log = logOf(run.runId);
    expect(log).toMatch(/=== precondition: echo lock is free; exit 0 ===\nlock is free\n=== precondition ok ===/);
    expect(log).toContain("job ran");
  });

  it("exit 75 records the run as deferred and starts nothing", async () => {
    const marker = path.join(tmpDir, "job-ran");
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ precondition: "echo 'autopilot lock: HELD pid=7 age=3m'; exit 75" }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", `touch "${marker}"`],
      maxRetries: 2,
    });
    expect(run).toMatchObject({ status: "deferred", exitCode: 75 });
    expect(fs.existsSync(marker)).toBe(false);
    expect(statusOf(run.runId)).toMatchObject({ status: "deferred", exitCode: 75 });
    expect(logOf(run.runId)).toContain("autopilot lock: HELD pid=7 age=3m");
    expect(logOf(run.runId)).toMatch(/exit 75: deferred, nothing ran/);
    // No session, no cost, no AI-session activity; the run record is still complete.
    expect(readRunCost(tmpDir, "job", run.runId)).toMatchObject({ totalCostUsd: null, coverage: "unavailable" });
    expect(JSON.parse(fs.readFileSync(path.join(runDir(run.runId), "stats.json"), "utf8"))).toMatchObject({ isAiSession: false, finalized: true });
    expect(fs.readlinkSync(path.join(tmpDir, "data", "runs", "job", "latest"))).toBe(run.runId);
  });

  it("a deferred claude job is not counted as an AI session", async () => {
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ type: "claude", command: undefined, prompt: "p", precondition: "exit 75" }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", "echo never"],
    });
    expect(run.status).toBe("deferred");
    expect(JSON.parse(fs.readFileSync(path.join(runDir(run.runId), "stats.json"), "utf8")).isAiSession).toBe(false);
  });

  it("any other failure fails the run with the precondition's output, and the job never runs", async () => {
    const marker = path.join(tmpDir, "job-ran");
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ precondition: "echo 'lock-status.sh not found' >&2; exit 1" }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", `touch "${marker}"`],
    });
    expect(run).toMatchObject({ status: "failed", exitCode: 1 });
    expect(fs.existsSync(marker)).toBe(false);
    expect(logOf(run.runId)).toContain("lock-status.sh not found");
    expect(logOf(run.runId)).toMatch(/precondition exit 1: run failed/);
  });

  it("a precondition past precondition_timeout is killed and fails the run", async () => {
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ precondition: "exec sleep 30", precondition_timeout: 0.3 }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", "echo never"],
    });
    expect(run.status).toBe("failed");
    expect(logOf(run.runId)).toMatch(/precondition timed out after 0.3s/);
    expect(logOf(run.runId)).not.toContain("never");
  }, 10_000);

  it("runs in the job's directory with the job's env and run ids", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "jobdir-"));
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ directory: dir, precondition: 'echo "pwd=$(pwd) trigger=$SCHEDULER_TRIGGER job=$SCHEDULER_JOB_ID run=$SCHEDULER_RUN_ID"' }),
      projectRoot: tmpDir,
      trigger: "catchup",
      catchupFor: "2026-10-16T09:00:00.000Z",
      command: "true",
    });
    expect(logOf(run.runId)).toContain(`pwd=${fs.realpathSync(dir)} trigger=catchup job=job run=${run.runId}`);
  });
});

describe("blocked and killed", () => {
  const counterCmd = (counterFile: string, exitExpr: string): string[] => [
    "-c",
    `n=$(cat "${counterFile}" 2>/dev/null || echo 0); n=$((n+1)); printf "%s" "$n" > "${counterFile}"; ${exitExpr}`,
  ];

  it("an exit code listed under outcome_codes.blocked is blocked, not failed, and is not retried", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "job",
      jobConfig: job({ outcome_codes: { blocked: [30] } }),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "echo 'PR needs its author'; exit 30"),
      maxRetries: 2,
    });
    expect(run).toMatchObject({ status: "blocked", exitCode: 30 });
    expect(statusOf(run.runId).status).toBe("blocked");
    expect(fs.readFileSync(counter, "utf8")).toBe("1");
    expect(logOf(run.runId)).toMatch(/exit 30: blocked, waiting on a person/);
  });

  it("the same exit code without outcome_codes stays failed and is retried as before", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "job",
      jobConfig: job(),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "exit 30"),
      maxRetries: 1,
    });
    expect(run).toMatchObject({ status: "failed", exitCode: 30 });
    expect(fs.readFileSync(counter, "utf8")).toBe("2");
  });

  it("a process that ends on a signal is killed (no exit code), not failed, and is not retried", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "job",
      jobConfig: job(),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "kill -KILL $$"),
      maxRetries: 2,
    });
    expect(run).toMatchObject({ status: "killed", exitCode: null });
    expect(statusOf(run.runId)).toMatchObject({ status: "killed", exitCode: null });
    expect(fs.readFileSync(counter, "utf8")).toBe("1");
    expect(logOf(run.runId)).toMatch(/without an exit code: killed/);
  });
});

describe("usage limit (2026-10-16)", () => {
  // claude -p prints the account's limit line and exits 1; fourteen Air runs failed that way
  // on 2026-10-16 06:00-09:50Z and max_retries would only repeat it. The run is blocked with
  // the reset parsed, and nothing is retried.
  const counterCmd = (counterFile: string, body: string): string[] => [
    "-c",
    `n=$(cat "${counterFile}" 2>/dev/null || echo 0); n=$((n+1)); ` +
      `printf "%s" "$n" > "${counterFile}"; ${body}`,
  ];

  it("a failed attempt whose output names the limit is blocked, not retried, with the reset in status.json", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "job",
      jobConfig: job(),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(
        counter,
        `echo "Reviewing..."; echo "You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)" >&2; exit 1`,
      ),
      maxRetries: 2,
    });
    expect(run).toMatchObject({
      status: "blocked",
      exitCode: 1,
      usageLimit: { kind: "weekly", zone: "Europe/Prague", text: "You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)" },
    });
    expect(run.usageLimit?.resetsAt).toMatch(/T03:00:00\.000Z$/); // 5am Prague, CEST
    expect(fs.readFileSync(counter, "utf8")).toBe("1");
    expect(statusOf(run.runId)).toMatchObject({
      status: "blocked",
      exitCode: 1,
      blockedReason: "usage-limit",
      usageLimit: { kind: "weekly" },
    });
    expect(logOf(run.runId)).toMatch(/weekly usage limit is exhausted/);
  });

  it("an ordinary failure is still failed, and a success that merely mentions the phrase is success", async () => {
    const failed = await runJob({
      jobId: "job",
      jobConfig: job(),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", "echo boom; exit 1"],
    });
    expect(failed).toMatchObject({ status: "failed", exitCode: 1 });
    expect(statusOf(failed.runId).blockedReason).toBeUndefined();
    const ok = await runJob({
      jobId: "job",
      jobConfig: job(),
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: ["-c", "echo \"found: You've hit your session limit · resets 7am (Europe/Prague)\"; exit 0"],
    });
    expect(ok.status).toBe("success");
    expect(ok.usageLimit).toBeUndefined();
  });
});
