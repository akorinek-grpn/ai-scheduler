import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runJob, countToolUseInStreamEvent } from "../job-runner";
import { getStatsPath } from "@shared/paths";
import fs from "fs";
import path from "path";
import os from "os";
import type { JobConfig, TriggerType } from "@shared/types";

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

describe("runJob", () => {
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

    const meta = JSON.parse(
      fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"),
    );
    expect(meta.jobId).toBe("test-job");
    expect(meta.trigger).toBe("manual");

    const status = JSON.parse(
      fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
    );
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
    const status = JSON.parse(
      fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
    );
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
    const status = JSON.parse(
      fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
    );
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
    const status = JSON.parse(
      fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
    );
    expect(status.status).toBe("timeout");
  }, 10000);

  it("kills the whole process group, not just the spawned shell", async () => {
    // Reproduces the wedge seen in production: the daemon spawns `/bin/sh -c`,
    // and signalling only that shell leaves npm/node grandchildren alive. They
    // keep the inherited stdout pipe open, so `close` never fires, the run is
    // pinned at "running" forever, and the job is skipped as "still active"
    // until the daemon restarts.
    const marker = path.join(tmpDir, "grandchild-alive");
    const timeoutSec = 0.5;
    const jobWithTimeout: JobConfig = { ...testJob, timeout: timeoutSec };

    const run = await runJob({
      jobId: "test-job",
      jobConfig: jobWithTimeout,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "/bin/sh",
      // The grandchild outlives the shell and touches the marker if it survives.
      args: [
        "-c",
        `sh -c 'sleep 3; printf alive > "${marker}"' & wait`,
      ],
      defaultTimeout: timeoutSec,
      sigkillGraceMs: 200,
    });

    const status = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "data", "runs", "test-job", run.runId, "status.json"),
        "utf-8",
      ),
    );
    expect(status.status).toBe("timeout");

    // Give the grandchild past its own deadline; if the group kill worked it
    // died with the shell and never wrote the marker.
    await new Promise((r) => setTimeout(r, 3500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 20000);

  it("force-kills a process that ignores SIGTERM within the grace window", async () => {
    // Reproduces the SIGKILL-fallback bug: a process that traps SIGTERM (like a
    // hung `claude -p`) must be escalated to SIGKILL after the grace period. The
    // child self-exits after 4s so a broken fallback can't leak it; the signal is
    // timing — a working fallback kills it ~(timeout + grace), not ~4s later.
    const timeoutSec = 0.3;
    const graceMs = 300;
    const jobWithTimeout: JobConfig = { ...testJob, timeout: timeoutSec };

    const start = Date.now();
    const run = await runJob({
      jobId: "test-job",
      jobConfig: jobWithTimeout,
      projectRoot: tmpDir,
      trigger: "manual",
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 4000);",
      ],
      defaultTimeout: timeoutSec,
      sigkillGraceMs: graceMs,
    });
    const elapsedMs = Date.now() - start;

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(
      fs.readFileSync(path.join(runDir, "status.json"), "utf-8"),
    );
    expect(status.status).toBe("timeout");
    // Force-kill must land within timeout + grace (+ spawn/scheduling headroom),
    // well before the child's own 4s self-exit.
    expect(elapsedMs).toBeLessThan(timeoutSec * 1000 + graceMs + 900);
  }, 15000);
});

describe("countToolUseInStreamEvent", () => {
  it("returns tool_use names from an assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Read", input: { file_path: "/x" } },
        ],
      },
    });
    expect(countToolUseInStreamEvent(line)).toEqual(["Bash", "Read"]);
  });

  it("returns an empty array for non-assistant events", () => {
    expect(
      countToolUseInStreamEvent(JSON.stringify({ type: "result", result: "" })),
    ).toEqual([]);
    expect(
      countToolUseInStreamEvent(JSON.stringify({ type: "user", message: {} })),
    ).toEqual([]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(countToolUseInStreamEvent("not json")).toEqual([]);
    expect(countToolUseInStreamEvent("")).toEqual([]);
  });
});

describe("runJob stats.json", () => {
  it("writes stats.json with zero counts for test command overrides", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const statsPath = getStatsPath(tmpDir, "test-job", run.runId);
    expect(fs.existsSync(statsPath)).toBe(true);

    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolsByName).toEqual({});
    // testJob has no `type` set → defaults to claude semantics for stats.
    expect(stats.isAiSession).toBe(true);
  });

  it("writes stats.json with isAiSession=false for script jobs", async () => {
    const scriptJob: JobConfig = {
      ...testJob,
      type: "script",
      command: "echo hi",
    };
    const run = await runJob({
      jobId: "script-job",
      jobConfig: scriptJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const stats = JSON.parse(
      fs.readFileSync(getStatsPath(tmpDir, "script-job", run.runId), "utf-8"),
    );
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolsByName).toEqual({});
    expect(stats.isAiSession).toBe(false);
  });
});

describe("runJob catchupFor", () => {
  it("persists catchupFor into meta.json when provided", async () => {
    const missedSlot = "2026-04-28T09:00:00.000Z";
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "catchup",
      catchupFor: missedSlot,
      command: "echo",
      args: ["catchup"],
    });

    const metaPath = path.join(
      tmpDir,
      "data",
      "runs",
      "test-job",
      run.runId,
      "meta.json",
    );
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.trigger).toBe("catchup");
    expect(meta.catchupFor).toBe(missedSlot);
  });

  it("does not write catchupFor when not provided", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["plain"],
    });

    const metaPath = path.join(
      tmpDir,
      "data",
      "runs",
      "test-job",
      run.runId,
      "meta.json",
    );
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.catchupFor).toBeUndefined();
  });
});

describe("runJob scheduler env", () => {
  // A job can act on the slot's date deterministically instead of "today" (2026-09-28:
  // next-morning catch-ups of pre-meeting-prep / executive-review worked on the wrong day).
  const printEnv = [
    "-c",
    'echo "trigger=$SCHEDULER_TRIGGER catchupFor=${SCHEDULER_CATCHUP_FOR-unset}"',
  ];
  const logOf = (runId: string): string =>
    fs.readFileSync(
      path.join(tmpDir, "data", "runs", "test-job", runId, "output.log"),
      "utf-8",
    );

  it("passes a catch-up run its trigger and the missed slot", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "catchup",
      catchupFor: "2026-09-16T15:00:00.000Z",
      command: "sh",
      args: printEnv,
    });
    expect(logOf(run.runId)).toContain(
      "trigger=catchup catchupFor=2026-09-16T15:00:00.000Z",
    );
  });

  it.each(["scheduled", "manual"] as const)(
    "passes a %s run its trigger and no SCHEDULER_CATCHUP_FOR, even one the daemon inherited",
    async (trigger) => {
      process.env.SCHEDULER_CATCHUP_FOR = "2026-01-01T00:00:00.000Z";
      try {
        const run = await runJob({
          jobId: "test-job",
          jobConfig: testJob,
          projectRoot: tmpDir,
          trigger,
          command: "sh",
          args: printEnv,
        });
        expect(logOf(run.runId)).toContain(`trigger=${trigger} catchupFor=unset`);
      } finally {
        delete process.env.SCHEDULER_CATCHUP_FOR;
      }
    },
  );
});

describe("runJob maxRetries", () => {
  // A command that increments a counter file and exits based on the attempt
  // number. Lets a test assert exactly how many attempts ran.
  const counterCmd = (counterFile: string, exitExpr: string): string[] => [
    "-c",
    `n=$(cat "${counterFile}" 2>/dev/null || echo 0); n=$((n+1)); ` +
      `printf "%s" "$n" > "${counterFile}"; ${exitExpr}`,
  ];
  const readCounter = (counterFile: string): number =>
    parseInt(fs.readFileSync(counterFile, "utf-8"), 10);
  const statusOf = (run: { runId: string }, jobId = "test-job") =>
    JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "data", "runs", jobId, run.runId, "status.json"),
        "utf-8",
      ),
    );

  it("retries a failing job until an attempt succeeds", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      // exit 1 until the 3rd attempt, then exit 0
      args: counterCmd(counter, '[ "$n" -ge 3 ] && exit 0 || exit 1'),
      maxRetries: 3,
    });

    expect(statusOf(run).status).toBe("success");
    expect(readCounter(counter)).toBe(3); // failed twice, succeeded on 3rd
  });

  it("stops after exhausting maxRetries and reports the last failure", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "exit 1"),
      maxRetries: 2,
    });

    expect(statusOf(run).status).toBe("failed");
    expect(readCounter(counter)).toBe(3); // 1 initial + 2 retries
  });

  it("retries a partial (exit 2) run - covers the weekly-ops failure class", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      // exit 2 (partial) on first attempt, exit 0 on the second
      args: counterCmd(counter, '[ "$n" -ge 2 ] && exit 0 || exit 2'),
      maxRetries: 2,
    });

    expect(statusOf(run).status).toBe("success");
    expect(readCounter(counter)).toBe(2);
  });

  it("does not retry a run that succeeds on the first attempt", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "exit 0"),
      maxRetries: 3,
    });

    expect(statusOf(run).status).toBe("success");
    expect(readCounter(counter)).toBe(1); // ran exactly once
  });

  it("logs a retry marker between attempts", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "exit 1"),
      maxRetries: 1,
    });

    const log = fs.readFileSync(
      path.join(tmpDir, "data", "runs", "test-job", run.runId, "output.log"),
      "utf-8",
    );
    expect(log).toMatch(/retry 1\/1/);
  });

  it("does not retry a timed-out run and says why in the log", async () => {
    // Reproduces the babysit-prs failure class: a timed-out attempt has used
    // its full time budget doing real work (it had already posted PR comments),
    // so retrying duplicates side effects and burns maxRetries x timeout more
    // wall-clock for nothing.
    const counter = path.join(tmpDir, "counter");
    const jobWithTimeout: JobConfig = { ...testJob, timeout: 1 };
    const run = await runJob({
      jobId: "test-job",
      jobConfig: jobWithTimeout,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      // exec so SIGTERM hits the sleep itself; a forked sleep would orphan and
      // hold the stdout pipe open past the test timeout
      args: counterCmd(counter, "exec sleep 30"),
      defaultTimeout: 1,
      maxRetries: 2,
    });

    expect(statusOf(run).status).toBe("timeout");
    expect(readCounter(counter)).toBe(1); // ran exactly once - no retries

    const log = fs.readFileSync(
      path.join(tmpDir, "data", "runs", "test-job", run.runId, "output.log"),
      "utf-8",
    );
    expect(log).toMatch(/timed out after 1s/);
    expect(log).toMatch(/not retrying/i);
  }, 10000);

  it("logs a final summary when retries are exhausted", async () => {
    const counter = path.join(tmpDir, "counter");
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "sh",
      args: counterCmd(counter, "exit 1"),
      maxRetries: 1,
    });

    const log = fs.readFileSync(
      path.join(tmpDir, "data", "runs", "test-job", run.runId, "output.log"),
      "utf-8",
    );
    expect(log).toMatch(/giving up after 2 attempts.*failed.*exit code 1/i);
  });
});
