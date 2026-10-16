import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CronEngine } from "../cron-engine";
import { CatchupQueue } from "../catchup";
import * as jobRunner from "../job-runner";
import * as evaluator from "../evaluator";
import { getNewestRunStartedAt, getRunDir } from "@shared/paths";
import type { SchedulerConfig } from "@shared/config-schema";

// A run deferred by its precondition (exit 75) is retried for the same slot after retry_after,
// twice at most, through the catch-up queue; a scheduled run in between covers the retry; the
// job's `catchup` policy does not apply; a manual run is never retried (plan 2, 2026-10-16).

type Started = { trigger: string; catchupFor?: string; slot?: string; deferredRetry?: number; at: string };

describe("deferred runs and their retries", () => {
  let tmpDir: string;
  let started: Started[];
  let outcomes: Array<"deferred" | "success">;
  let engine: CronEngine;
  let queue: CatchupQueue;

  const config = (extra: Partial<SchedulerConfig["jobs"][string]> = {}): SchedulerConfig => ({
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50, priority: "background" },
    jobs: {
      hourly: {
        name: "Hourly",
        schedule: "0 * * * *",
        directory: "/tmp",
        type: "claude",
        prompt: "p",
        enabled: true,
        skip_permissions: false,
        tags: [],
        precondition: "exit 75",
        ...extra,
      },
    },
  });

  /** A run directory as job-runner leaves a deferred run, so the real evaluator and sweeps can read it. */
  const writeRun = (jobId: string, status: "deferred" | "success", opts: Parameters<typeof jobRunner.runJob>[0]): string => {
    const at = new Date();
    const runId = `${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${started.length.toString(16).padStart(6, "0")}`;
    const dir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ jobId, runId, trigger: opts.trigger, startedAt: at.toISOString(), jobConfig: opts.jobConfig, ...(opts.catchupFor ? { catchupFor: opts.catchupFor } : {}) }),
    );
    fs.writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({ status, exitCode: status === "deferred" ? 75 : 0, startedAt: at.toISOString(), finishedAt: at.toISOString() }),
    );
    fs.writeFileSync(path.join(dir, "output.log"), status === "deferred" ? "=== precondition: exit 75 ===\nautopilot lock: HELD pid=7 age=3m\n=== precondition exit 75: deferred, nothing ran ===\n" : "ok\n");
    return runId;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-deferred-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
    vi.useFakeTimers({ now: new Date("2026-10-16T13:00:00Z") });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    started = [];
    outcomes = [];
    vi.spyOn(jobRunner, "runJob").mockImplementation(async (opts) => {
      const status = outcomes.shift() ?? "success";
      started.push({ trigger: opts.trigger, catchupFor: opts.catchupFor, slot: opts.slot, deferredRetry: opts.deferredRetry, at: new Date().toISOString() });
      const runId = writeRun(opts.jobId, status, opts);
      return { runId, status, exitCode: status === "deferred" ? 75 : 0 };
    });
    vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
  });

  afterEach(() => {
    engine?.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const wire = (cfg: SchedulerConfig) => {
    engine = new CronEngine(tmpDir);
    engine.loadJobs(cfg);
    queue = new CatchupQueue({
      runCatchup: async (id, slot, options) => {
        await engine.runCatchup(id, slot, options);
      },
      isJobActive: (id) => engine.getActiveJobIds().includes(id),
      jobName: (id) => id,
      catchupPolicy: (id) => engine.getCurrentConfig()?.jobs[id]?.catchup,
      newestRunStartedAt: (id) => getNewestRunStartedAt(tmpDir, id),
    });
    engine.setCatchupQueue(queue);
  };
  const tick = (slotIso: string) =>
    (engine as unknown as { executeJob: (id: string, slot: Date) => Promise<void> }).executeJob("hourly", new Date(slotIso));

  it("retries the slot after retry_after, twice at most, then gives up until the next slot", async () => {
    wire(config({ retry_after: 300 }));
    outcomes = ["deferred", "deferred", "deferred"];
    await tick("2026-10-16T13:00:00Z");
    expect(started).toHaveLength(1);
    expect(queue.snapshot().queued).toEqual([
      expect.objectContaining({ jobId: "hourly", kind: "retry", retry: 1, missedSlot: "2026-10-16T13:00:00.000Z", notBefore: "2026-10-16T13:05:00.000Z" }),
    ]);
    // The deferred run is rated ok by the scheduler itself, no model call, and the ledger has the line.
    const evaluation = JSON.parse(fs.readFileSync(path.join(getRunDir(tmpDir, "hourly", started.length ? fs.readdirSync(path.join(tmpDir, "data", "runs", "hourly")).filter((n) => n !== "latest")[0] : ""), "evaluation.json"), "utf8"));
    expect(evaluation).toMatchObject({ severity: "ok", followUpNeeded: false, source: "scheduler" });
    expect(evaluation.summary).toContain("HELD pid=7");
    expect(evaluator.evaluateRun).not.toHaveBeenCalled();
    const ledger = fs.readFileSync(path.join(tmpDir, "data", "evaluations", "2026-10.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(ledger[0])).toMatchObject({ status: "deferred", evaluation: { source: "scheduler", severity: "ok" }, decision: { state: "off" } });

    await vi.advanceTimersByTimeAsync(299_000);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(started[1]).toMatchObject({ trigger: "catchup", catchupFor: "2026-10-16T13:00:00.000Z", slot: "2026-10-16T13:00:00.000Z", deferredRetry: 1 });
    expect(queue.snapshot().queued).toEqual([expect.objectContaining({ kind: "retry", retry: 2 })]);

    await vi.advanceTimersByTimeAsync(301_000);
    expect(started[2]).toMatchObject({ trigger: "catchup", deferredRetry: 2 });
    // Third deferral: no further retry for this slot.
    expect(queue.snapshot().queued).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(started).toHaveLength(3);
  });

  it("a retry that finally runs is an ordinary catch-up-triggered run of the same slot", async () => {
    wire(config({ retry_after: 60 }));
    outcomes = ["deferred", "success"];
    await tick("2026-10-16T13:00:00Z");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(started.map((s) => s.trigger)).toEqual(["scheduled", "catchup"]);
    expect(evaluator.evaluateRun).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().queued).toEqual([]);
  });

  it("ignores catchup: never (the retry is the slot's own run, not a catch-up)", async () => {
    wire(config({ retry_after: 60, catchup: "never" }));
    outcomes = ["deferred", "success"];
    await tick("2026-10-16T13:00:00Z");
    expect(queue.snapshot().queued).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(started).toHaveLength(2);
  });

  it("drops the retry when the job runs anyway before it is due", async () => {
    wire(config({ retry_after: 3600 }));
    outcomes = ["deferred", "success"];
    await tick("2026-10-16T13:00:00Z");
    expect(queue.snapshot().queued).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await tick("2026-10-16T14:00:00Z"); // the next slot's own run
    expect(started).toHaveLength(2);
    expect(queue.snapshot().queued).toEqual([]);
    // Past the retry's notBefore (and past node-cron's own next top-of-hour tick): no retry runs.
    await vi.advanceTimersByTimeAsync(3_700_000);
    expect(started.filter((s) => s.trigger === "catchup")).toEqual([]);
  });

  it("uses the 10-minute default and never retries a manual run", async () => {
    wire(config());
    outcomes = ["deferred", "deferred"];
    await tick("2026-10-16T13:00:00Z");
    expect(queue.snapshot().queued[0]).toMatchObject({ notBefore: "2026-10-16T13:10:00.000Z" });
    const result = await engine.triggerJob("hourly");
    expect(result).toHaveProperty("runId");
    expect(started[1].trigger).toBe("manual");
    // Still exactly the one retry from the scheduled run, replaced by nothing.
    expect(queue.snapshot().queued).toHaveLength(1);
    expect(queue.snapshot().queued[0]).toMatchObject({ retry: 1 });
  });
});
