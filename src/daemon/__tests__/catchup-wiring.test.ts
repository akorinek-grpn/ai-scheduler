import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { CronEngine } from "../cron-engine";
import { startCatchup, MISSED_TICK_POLL_MS } from "../catchup-wiring";
import * as jobRunner from "../job-runner";
import * as evaluator from "../evaluator";
import type { SchedulerConfig } from "@shared/config-schema";
import {
  getLatestSymlink,
  getMetaPath,
  getRunDir,
  getStatusPath,
} from "@shared/paths";

// startCatchup is exactly what index.ts runs. These tests drive it with a real CronEngine
// and real node-cron tasks on fake timers; only runJob (and the Haiku evaluator) are
// stubbed. The stub leaves run directories the way job-runner does.
describe("startCatchup (the daemon's catch-up wiring)", () => {
  let tmpDir: string;
  let started: { jobId: string; trigger: string; catchupFor?: string }[];
  let cleanup: (() => void)[];

  const makeConfig = (jobs: SchedulerConfig["jobs"]): SchedulerConfig => ({
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50 },
    jobs,
  });
  const job = (
    schedule: string,
    extra: Partial<SchedulerConfig["jobs"][string]> = {},
  ): SchedulerConfig["jobs"][string] => ({
    name: "Job",
    schedule,
    directory: "/tmp",
    type: "claude",
    prompt: "p",
    enabled: true,
    skip_permissions: false,
    tags: [],
    ...extra,
  });

  /**
   * A run directory as job-runner leaves it: the id starts with the UTC start time,
   * meta.json is written at start, and `latest` moves only when the run finishes.
   */
  const writeRun = (
    jobId: string,
    startedAt: string,
    opts: { finished: boolean },
  ): string => {
    const runId = `${startedAt.replace(/[:.]/g, "-").slice(0, 19)}-${crypto.randomBytes(3).toString("hex")}`;
    fs.mkdirSync(getRunDir(tmpDir, jobId, runId), { recursive: true });
    fs.writeFileSync(
      getMetaPath(tmpDir, jobId, runId),
      JSON.stringify({ jobId, runId, trigger: "scheduled", startedAt }),
    );
    fs.writeFileSync(
      getStatusPath(tmpDir, jobId, runId),
      JSON.stringify({ status: opts.finished ? "success" : "failed" }),
    );
    if (opts.finished) {
      fs.rmSync(getLatestSymlink(tmpDir, jobId), { force: true });
      fs.symlinkSync(runId, getLatestSymlink(tmpDir, jobId));
    }
    return runId;
  };

  const start = (config: SchedulerConfig) => {
    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);
    const wiring = startCatchup(engine, { projectRoot: tmpDir });
    cleanup.push(() => {
      wiring.stop();
      engine.stopAll();
    });
    return { engine, wiring };
  };

  /** Let node-cron's heartbeat for `slotIso` fire `lateMs` after the slot. */
  const tickAt = async (slotIso: string, lateMs: number) => {
    const slot = Date.parse(slotIso);
    await vi.advanceTimersByTimeAsync(slot - 1 - Date.now());
    vi.setSystemTime(slot + lateMs); // pending timers shift with the clock
    await vi.advanceTimersByTimeAsync(10);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-wiring-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
    cleanup = [];
    started = [];
    vi.useFakeTimers({ now: new Date("2026-09-24T12:58:00Z") });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(jobRunner, "runJob").mockImplementation(async (opts) => {
      started.push({
        jobId: opts.jobId,
        trigger: opts.trigger,
        catchupFor: opts.catchupFor,
      });
      const runId = writeRun(opts.jobId, new Date().toISOString(), {
        finished: true,
      });
      return { runId, status: "success", exitCode: 0 };
    });
    // No real Haiku evaluation from a unit test.
    vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
  });

  afterEach(() => {
    for (const fn of cleanup) fn();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recovers a tick node-cron dropped as one catch-up of that slot", async () => {
    writeRun("hourly", "2026-09-24T12:00:00.020Z", { finished: true });
    start(makeConfig({ hourly: job("0 * * * *") }));
    expect(started).toEqual([]); // nothing missed at startup

    await tickAt("2026-09-24T13:00:00Z", 1300); // 1.3 s late: node-cron drops it
    await vi.advanceTimersByTimeAsync(4 * MISSED_TICK_POLL_MS);

    expect(started).toEqual([
      {
        jobId: "hourly",
        trigger: "catchup",
        catchupFor: "2026-09-24T13:00:00.000Z",
      },
    ]);
  });

  it("applies the job's catchup policy to a dropped tick (catchup: never)", async () => {
    writeRun("hourly", "2026-09-24T12:00:00.020Z", { finished: true });
    start(makeConfig({ hourly: job("0 * * * *", { catchup: "never" }) }));

    await tickAt("2026-09-24T13:00:00Z", 1300);
    await vi.advanceTimersByTimeAsync(4 * MISSED_TICK_POLL_MS);

    expect(started).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Skipped hourly catch-up .*catchup: never/),
    );
  });

  it("does not catch up a slot from before a hot reload added the job", async () => {
    const { engine, wiring } = start(makeConfig({}));
    await vi.advanceTimersByTimeAsync(
      Date.parse("2026-09-24T13:00:30Z") - Date.now(),
    );
    engine.loadJobs(makeConfig({ added: job("0 * * * *") })); // 30 s after its 13:00 slot

    await vi.advanceTimersByTimeAsync(4 * MISSED_TICK_POLL_MS);

    expect(started).toEqual([]);
    expect(wiring.queue.snapshot().queued).toEqual([]);
  });

  it("counts a changed schedule's slots from the reload, not from the old task", async () => {
    writeRun("job", "2026-09-24T12:30:00.020Z", { finished: true });
    const { engine } = start(makeConfig({ job: job("30 * * * *") }));
    await vi.advanceTimersByTimeAsync(
      Date.parse("2026-09-24T13:00:30Z") - Date.now(),
    );
    engine.loadJobs(makeConfig({ job: job("0 * * * *") })); // 13:00 slot never existed for it

    await vi.advanceTimersByTimeAsync(4 * MISSED_TICK_POLL_MS);

    expect(started).toEqual([]);
  });

  it("after a restart, does not re-run a slot whose run is still going or was orphaned", async () => {
    // Review E2E 2026-09-28: the daemon was restarted 12 s after the 14:00 slot. That run's
    // detached child outlived it; cleanupOrphanedRuns marked it failed, and `latest` still
    // pointed at the 13:00 run because it only moves when a run completes.
    vi.setSystemTime(new Date("2026-09-24T14:00:12Z"));
    writeRun("busy", "2026-09-24T13:00:00.020Z", { finished: true });
    writeRun("busy", "2026-09-24T14:00:00.020Z", { finished: false });
    writeRun("idle", "2026-09-24T13:00:00.020Z", { finished: true }); // its 14:00 never started

    start(makeConfig({ busy: job("0 * * * *"), idle: job("0 * * * *") }));
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(started).toEqual([
      {
        jobId: "idle",
        trigger: "catchup",
        catchupFor: "2026-09-24T14:00:00.000Z",
      },
    ]);
  });

  describe("a queued catch-up the job ran anyway before its turn (2026-09-29)", () => {
    // Live daemon, 2026-09-29: at 06:13Z the gap watcher queued babysit-prs (hourly, :00) for
    // its 06:00Z slot behind five other catch-ups. Its regular 07:00Z tick could run first,
    // and the stale catch-up still ran afterwards: two runs for one missed run.
    let held: Map<string, Promise<void>>;

    beforeEach(() => {
      held = new Map();
      const plain = vi.mocked(jobRunner.runJob).getMockImplementation()!;
      vi.mocked(jobRunner.runJob).mockImplementation(async (opts) => {
        const key = `${opts.jobId}:${opts.trigger}`;
        const gate = held.get(key);
        if (!gate) return plain(opts);
        held.delete(key);
        started.push({
          jobId: opts.jobId,
          trigger: opts.trigger,
          catchupFor: opts.catchupFor,
        });
        const runId = writeRun(opts.jobId, new Date().toISOString(), {
          finished: false,
        });
        await gate;
        fs.rmSync(getLatestSymlink(tmpDir, opts.jobId), { force: true });
        fs.symlinkSync(runId, getLatestSymlink(tmpDir, opts.jobId));
        return { runId, status: "success", exitCode: 0 };
      });
    });

    /** The next `trigger` run of `jobId` keeps running until the returned function is called. */
    const hold = (jobId: string, trigger: string): (() => void) => {
      let release!: () => void;
      held.set(
        `${jobId}:${trigger}`,
        new Promise<void>((r) => (release = r)),
      );
      return () => release();
    };

    const runsOf = (jobId: string) =>
      started
        .filter((s) => s.jobId === jobId)
        .map((s) => (s.catchupFor ? `${s.trigger}@${s.catchupFor}` : s.trigger));

    const queued = (wiring: ReturnType<typeof startCatchup>) =>
      wiring.queue.snapshot().queued.map((e) => `${e.jobId}@${e.missedSlot}`);

    const logs = (prefix: string) =>
      vi
        .mocked(console.log)
        .mock.calls.map(([msg]) => String(msg))
        .filter((msg) => msg.startsWith(prefix));

    /**
     * That morning: the lid closes at 05:59:10 and opens at 06:13, and the gap watcher queues
     * babysit's 06:00 slot behind another job's catch-up (`slow`, running until releaseSlow).
     */
    const wakeWithBabysitQueued = async () => {
      vi.setSystemTime(new Date("2026-09-29T05:59:00Z"));
      writeRun("slow", "2026-09-29T05:10:00.020Z", { finished: true });
      writeRun("babysit", "2026-09-29T05:00:00.020Z", { finished: true });
      const releaseSlow = hold("slow", "catchup");
      const daemon = start(
        makeConfig({ slow: job("10 * * * *"), babysit: job("0 * * * *") }),
      );
      expect(started).toEqual([]); // nothing missed at 05:59

      await vi.advanceTimersByTimeAsync(10_000);
      vi.setSystemTime(new Date("2026-09-29T06:13:00Z")); // asleep 05:59:10-06:13
      await vi.advanceTimersByTimeAsync(30_000); // the gap watcher's next poll sees the gap
      expect(runsOf("slow")).toEqual(["catchup@2026-09-29T06:10:00.000Z"]); // still running
      expect(queued(daemon.wiring)).toEqual([
        "babysit@2026-09-29T06:00:00.000Z",
      ]);
      return { ...daemon, releaseSlow };
    };

    it("drops it once the job's next scheduled run covers the slot: one run for the missed slot (babysit-prs)", async () => {
      const { wiring, releaseSlow } = await wakeWithBabysitQueued();

      await tickAt("2026-09-29T07:00:00Z", 20); // babysit's 07:00 tick runs before its turn
      expect(runsOf("babysit")).toEqual(["scheduled"]);
      expect(queued(wiring)).toEqual([]); // gone while the head is still running
      expect(logs("[catchup] Dropped babysit ")).toEqual([
        expect.stringMatching(
          /^\[catchup\] Dropped babysit catch-up for missed slot 2026-09-29T06:00:00\.000Z: already covered by the run started 2026-09-29T07:00:00\.\d{3}Z$/,
        ),
      ]);

      releaseSlow();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(runsOf("babysit")).toEqual(["scheduled"]);
    });

    it("drops it when a manual run started after the slot, even while that run is still going", async () => {
      const { engine, wiring, releaseSlow } = await wakeWithBabysitQueued();
      const releaseManual = hold("babysit", "manual");
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      const manual = engine.triggerJob("babysit"); // Run now, at 06:19:30
      expect(runsOf("babysit")).toEqual(["manual"]);

      releaseSlow(); // the queue's head ends while the manual run is still going
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(queued(wiring)).toEqual([]);
      expect(logs("[catchup] Dropped babysit ")).toEqual([
        expect.stringMatching(
          /already covered by the run started 2026-09-29T06:19:30\.\d{3}Z$/,
        ),
      ]);

      releaseManual();
      await manual;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runsOf("babysit")).toEqual(["manual"]);
    });

    it("keeps the catch-up of a slot a longer run overlapped and runs it once after that run", async () => {
      vi.setSystemTime(new Date("2026-09-29T04:58:00Z"));
      writeRun("babysit", "2026-09-29T04:00:00.020Z", { finished: true });
      const releaseLong = hold("babysit", "scheduled");
      const { wiring } = start(makeConfig({ babysit: job("0 * * * *") }));

      await tickAt("2026-09-29T05:00:00Z", 20); // a run still going at 06:00
      await tickAt("2026-09-29T06:00:00Z", 20); // skipped: queued for its own slot
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(queued(wiring)).toEqual(["babysit@2026-09-29T06:00:00.000Z"]);

      releaseLong(); // 06:20
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(runsOf("babysit")).toEqual([
        "scheduled",
        "catchup@2026-09-29T06:00:00.000Z",
      ]);
      expect(logs("[catchup] Dropped ")).toEqual([]);
    });

    it("gives an hourly job exactly one catch-up across the startup sweep, a long sleep and every missed-tick poll", async () => {
      // Daemon down 00:00-01:30 (01:00 missed), then asleep 02:30-06:40 (03:00-06:00 missed).
      vi.setSystemTime(new Date("2026-09-29T01:30:00Z"));
      writeRun("slow", "2026-09-29T00:10:00.020Z", { finished: true });
      writeRun("hourly", "2026-09-29T00:00:00.020Z", { finished: true });
      const releaseSlow = hold("slow", "catchup");
      start(makeConfig({ slow: job("10 * * * *"), hourly: job("0 * * * *") }));
      // Startup sweep: slow's 01:10 catch-up runs; hourly's 01:00 waits behind it.

      await tickAt("2026-09-29T02:00:00Z", 20); // hourly's own 02:00 run covers 01:00
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      releaseSlow(); // 02:15
      await vi.advanceTimersByTimeAsync(15 * 60_000); // 02:30

      vi.setSystemTime(new Date("2026-09-29T06:40:00Z")); // asleep until 06:40
      await vi.advanceTimersByTimeAsync(15 * 60_000); // wake sweep, polls, up to 06:55

      expect(runsOf("hourly")).toEqual([
        "scheduled",
        "catchup@2026-09-29T06:00:00.000Z",
      ]);
      expect(logs("[catchup] Dropped hourly ")).toEqual([
        expect.stringContaining("missed slot 2026-09-29T01:00:00.000Z"),
      ]);
    });

    it("does not queue a dropped slot again on later sweeps", async () => {
      const { engine, wiring, releaseSlow } = await wakeWithBabysitQueued();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await engine.triggerJob("babysit"); // a manual run at 06:19:30 covers 06:00
      expect(queued(wiring)).toEqual([]);

      await vi.advanceTimersByTimeAsync(5 * 60_000); // missed-tick polls
      vi.setSystemTime(new Date("2026-09-29T06:45:00Z")); // asleep 06:24:30-06:45
      await vi.advanceTimersByTimeAsync(60_000); // the wake sweep, more polls
      releaseSlow();
      await vi.advanceTimersByTimeAsync(10 * 60_000); // 06:56, before the next slot

      expect(logs("[catchup] Clock gap ")).toHaveLength(2);
      expect(logs("[catchup] Enqueued babysit ")).toHaveLength(1);
      expect(queued(wiring)).toEqual([]);
      expect(runsOf("babysit")).toEqual(["manual"]);
    });
  });
});
