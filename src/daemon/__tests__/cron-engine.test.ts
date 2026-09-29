import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronEngine } from "../cron-engine";
import { CatchupQueue, sweepMissedRuns } from "../catchup";
import * as jobRunner from "../job-runner";
import * as evaluator from "../evaluator";
import fs from "fs";
import path from "path";
import os from "os";
import type { SchedulerConfig } from "@shared/config-schema";

describe("CronEngine", () => {
  let tmpDir: string;
  let configPath: string;

  const makeConfig = (jobs: SchedulerConfig["jobs"]): SchedulerConfig => ({
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50 },
    jobs,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-cron-"));
    configPath = path.join(tmpDir, "scheduler.yaml");
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers jobs from config", () => {
    const config = makeConfig({
      "test-job": {
        name: "Test",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: true,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);

    expect(engine.getRegisteredJobIds()).toEqual(["test-job"]);
    engine.stopAll();
  });

  it("skips disabled jobs", () => {
    const config = makeConfig({
      "disabled-job": {
        name: "Disabled",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: false,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);

    expect(engine.getRegisteredJobIds()).toEqual([]);
    engine.stopAll();
  });

  it("tracks active jobs", () => {
    const engine = new CronEngine(tmpDir);
    expect(engine.getActiveJobIds()).toEqual([]);
    engine.stopAll();
  });

  it("removes jobs when config changes", () => {
    const config1 = makeConfig({
      "job-a": {
        name: "A",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "a",
        enabled: true,
        tags: [],
      },
      "job-b": {
        name: "B",
        schedule: "0 10 * * *",
        directory: "/tmp",
        prompt: "b",
        enabled: true,
        tags: [],
      },
    });

    const config2 = makeConfig({
      "job-a": {
        name: "A",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "a",
        enabled: true,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config1);
    expect(engine.getRegisteredJobIds().sort()).toEqual(["job-a", "job-b"]);

    engine.loadJobs(config2);
    expect(engine.getRegisteredJobIds()).toEqual(["job-a"]);

    engine.stopAll();
  });

  it("runCatchup runs a job with trigger=catchup and writes catchupFor in meta", async () => {
    const config = makeConfig({
      "catchup-test-job": {
        name: "Catch-up Test Job",
        schedule: "0 9 * * *",
        directory: os.tmpdir(),
        type: "script",
        command: "echo catchup-test",
        enabled: true,
        tags: [],
      },
    });

    // No real `claude -p --model haiku` evaluation from a unit test.
    const evaluate = vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);

    const result = await engine.runCatchup(
      "catchup-test-job",
      new Date("2026-04-28T09:00:00Z"),
    );

    expect(result).toHaveProperty("runId");
    if (!("runId" in result)) throw new Error("expected runId");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(
          tmpDir,
          "data",
          "runs",
          "catchup-test-job",
          result.runId,
          "meta.json",
        ),
        "utf-8",
      ),
    );
    expect(meta.trigger).toBe("catchup");
    expect(meta.catchupFor).toBe("2026-04-28T09:00:00.000Z");

    evaluate.mockRestore();
    engine.stopAll();
  });

  it("returns error from runCatchup when job is unknown", async () => {
    const engine = new CronEngine(tmpDir);
    engine.loadJobs(makeConfig({}));
    const result = await engine.runCatchup("missing", new Date());
    expect(result).toEqual({ error: "Job not found: missing" });
    engine.stopAll();
  });

  it("a scheduled tick runs the most recently loaded config, not the one it was scheduled with", async () => {
    // 2026-09-28: a prompt edit in scheduler.yaml (schedule unchanged) was hot-reloaded
    // but the cron closure still ran the old prompt until the daemon restarted.
    const job = (prompt: string): SchedulerConfig["jobs"] => ({
      "job-a": {
        name: "A",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt,
        enabled: true,
        tags: [],
      },
    });
    const runJob = vi.spyOn(jobRunner, "runJob").mockResolvedValue({
      runId: "r1",
      status: "success",
      exitCode: 0,
    } as unknown as Awaited<ReturnType<typeof jobRunner.runJob>>);
    // No real `claude -p --model haiku` evaluation from a unit test.
    const evaluate = vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(makeConfig(job("old prompt")));
    engine.loadJobs(makeConfig(job("new prompt"))); // same schedule: task is kept
    await (
      engine as unknown as { executeJob: (id: string) => Promise<void> }
    ).executeJob("job-a");

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0][0].jobConfig.prompt).toBe("new prompt");

    // A job removed or disabled after scheduling no longer runs on its stale tick.
    engine.loadJobs(makeConfig({}));
    await (
      engine as unknown as { executeJob: (id: string) => Promise<void> }
    ).executeJob("job-a");
    expect(runJob).toHaveBeenCalledTimes(1);

    runJob.mockRestore();
    evaluate.mockRestore();
    engine.stopAll();
  });

  describe("missed ticks (node-cron drops a heartbeat that fires 1 s or more late)", () => {
    type Started = { trigger: string; catchupFor?: string; at: string };
    let started: Started[];

    const hourly = (extra: Partial<SchedulerConfig["jobs"][string]> = {}) =>
      makeConfig({
        hourly: {
          name: "Hourly",
          schedule: "0 * * * *",
          directory: "/tmp",
          type: "claude",
          prompt: "p",
          enabled: true,
          skip_permissions: false,
          tags: [],
          ...extra,
        },
      });

    beforeEach(() => {
      vi.useFakeTimers({ now: new Date("2026-09-24T12:58:00Z") });
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      started = [];
      vi.spyOn(jobRunner, "runJob").mockImplementation(async (opts) => {
        started.push({
          trigger: opts.trigger,
          catchupFor: opts.catchupFor,
          at: new Date().toISOString(),
        });
        return { runId: `r${started.length}`, status: "success", exitCode: 0 };
      });
      // No real Haiku evaluation from a unit test.
      vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** The engine, queue and missed-tick poll, wired the way index.ts wires them. */
    const wire = (config: SchedulerConfig) => {
      const engine = new CronEngine(tmpDir);
      engine.loadJobs(config);
      const isActive = (id: string) => engine.getActiveJobIds().includes(id);
      const queue = new CatchupQueue({
        runCatchup: async (id, slot) => {
          await engine.runCatchup(id, slot);
        },
        isJobActive: isActive,
        jobName: (id) => id,
        catchupPolicy: (id) => engine.getCurrentConfig()?.jobs[id]?.catchup,
      });
      engine.setCatchupQueue(queue);
      const poll = () => {
        const found = sweepMissedRuns(
          {
            jobs: engine.getCurrentConfig()!.jobs,
            now: new Date(),
            lastStartedAt: () => started.at(-1)?.at ?? null,
            isActive,
            notBefore: (id) => engine.getScheduledSince(id),
          },
          queue,
        );
        queue.process();
        return found.map((e) => `${e.jobId}@${e.missedSlot.toISOString()}`);
      };
      return { engine, queue, poll };
    };

    /** Let node-cron's heartbeat for `slotIso` fire `lateMs` after the slot. */
    const tickAt = async (slotIso: string, lateMs: number) => {
      const slot = Date.parse(slotIso);
      await vi.advanceTimersByTimeAsync(slot - 1 - Date.now());
      vi.setSystemTime(slot + lateMs); // pending timers shift with the clock
      await vi.advanceTimersByTimeAsync(10);
    };

    it("recovers a dropped tick as exactly one catch-up for that slot, and never re-runs a slot that ran", async () => {
      const { engine, poll } = wire(hourly());
      await tickAt("2026-09-24T13:00:00Z", 20); // on time
      await tickAt("2026-09-24T14:00:00Z", 1300); // 1.3 s late: node-cron drops it
      expect(started.map((s) => s.trigger)).toEqual(["scheduled"]);

      expect(poll()).toEqual(["hourly@2026-09-24T14:00:00.000Z"]);
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(poll()).toEqual([]);
      }
      expect(started).toEqual([
        expect.objectContaining({ trigger: "scheduled" }),
        expect.objectContaining({
          trigger: "catchup",
          catchupFor: "2026-09-24T14:00:00.000Z",
        }),
      ]);
      engine.stopAll();
    });

    it("recovers the first tick after the task was scheduled (node-cron reports no missed execution for it)", async () => {
      const { engine, poll } = wire(hourly());
      await tickAt("2026-09-24T13:00:00Z", 1300);
      expect(started).toEqual([]);
      expect(poll()).toEqual(["hourly@2026-09-24T13:00:00.000Z"]);
      engine.stopAll();
    });

    it("does not treat a slot from before the task was scheduled as a dropped tick", async () => {
      vi.setSystemTime(new Date("2026-09-24T13:00:30Z")); // e.g. the job was added by a hot reload
      const { engine, poll } = wire(hourly());
      expect(poll()).toEqual([]);
      engine.stopAll();
    });

    it("a tick that fires while a catch-up for the same slot runs does not queue that slot again", async () => {
      const { engine, queue } = wire(hourly());
      // A sweep caught the 13:00 slot just before node-cron's (late but still matching) tick ran.
      let finish!: () => void;
      vi.mocked(jobRunner.runJob).mockImplementationOnce(async (opts) => {
        started.push({ trigger: opts.trigger, catchupFor: opts.catchupFor, at: "" });
        await new Promise<void>((r) => (finish = r));
        return { runId: "c1", status: "success", exitCode: 0 };
      });
      await vi.advanceTimersByTimeAsync(Date.parse("2026-09-24T13:00:00Z") - 1 - Date.now());
      expect(queue.enqueue("hourly", new Date("2026-09-24T13:00:00Z"))).toBe(true);
      queue.process();
      await vi.advanceTimersByTimeAsync(10); // node-cron's 13:00 tick fires: job is active
      expect(queue.snapshot().queued).toEqual([]);
      finish();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(started.map((s) => s.trigger)).toEqual(["catchup"]);
      engine.stopAll();
    });

    it("a tick that overlaps a longer run is queued for its own slot, unless the job says catchup: never", async () => {
      for (const [policy, expected] of [
        [undefined, ["2026-09-24T14:00:00.000Z"]],
        ["never", []],
      ] as const) {
        const { engine, queue } = wire(hourly(policy ? { catchup: policy } : {}));
        let finish!: () => void;
        vi.mocked(jobRunner.runJob).mockImplementationOnce(async () => {
          await new Promise<void>((r) => (finish = r));
          return { runId: "long", status: "success", exitCode: 0 };
        });
        await tickAt("2026-09-24T13:00:00Z", 20); // starts a run that is still going at 14:00
        await tickAt("2026-09-24T14:00:00Z", 20);
        expect(queue.snapshot().queued.map((e) => e.missedSlot)).toEqual(expected);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        engine.stopAll();
        vi.setSystemTime(new Date("2026-09-24T12:58:00Z"));
      }
    });
  });
});
