import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import path from "path";
import { CronExpressionParser } from "cron-parser";
import {
  detectMissedRun,
  CatchupQueue,
  sweepMissedRuns,
  startGapWatcher,
} from "../catchup";

const HOUR = 60 * 60 * 1000;

describe("detectMissedRun", () => {
  it("returns missedSlot when last run is older than the previous cron occurrence", () => {
    const now = new Date("2026-04-28T10:00:00Z");
    const lastStartedAt = new Date("2026-04-28T07:30:00Z").toISOString();
    // Hourly cron: previous slot before 10:00 is 09:00.
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt,
      now,
      isActive: false,
    });
    expect(missed?.toISOString()).toBe("2026-04-28T09:00:00.000Z");
  });

  it("returns null when last run is within tolerance of the previous slot", () => {
    // 09:59, not 10:01: since 2026-09-28 a sweep at 10:01 reports the 10:00 slot,
    // which has not run (the old 5-minute look-back offset hid it).
    const now = new Date("2026-04-28T09:59:00Z");
    // 09:02 — within 5min tolerance of the 09:00 slot.
    const lastStartedAt = new Date("2026-04-28T09:02:00Z").toISOString();
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt,
      now,
      isActive: false,
    });
    expect(missed).toBeNull();
  });

  it("returns null when previous slot is older than 24h", () => {
    const now = new Date("2026-04-28T10:00:00Z");
    // Schedule fires only on Jan 1 — previous occurrence is months ago.
    const missed = detectMissedRun({
      schedule: "0 0 1 1 *",
      lastStartedAt: null,
      now,
      isActive: false,
    });
    expect(missed).toBeNull();
  });

  it("returns missedSlot when no runs exist and previous slot is recent", () => {
    const now = new Date("2026-04-28T10:00:00Z");
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt: null,
      now,
      isActive: false,
    });
    expect(missed?.toISOString()).toBe("2026-04-28T09:00:00.000Z");
  });

  it("returns null when the job is currently active", () => {
    const now = new Date("2026-04-28T10:00:00Z");
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt: null,
      now,
      isActive: true,
    });
    expect(missed).toBeNull();
  });

  it("returns null for invalid cron expressions", () => {
    const now = new Date("2026-04-28T10:00:00Z");
    const missed = detectMissedRun({
      schedule: "this is not cron",
      lastStartedAt: null,
      now,
      isActive: false,
    });
    expect(missed).toBeNull();
  });
});

describe("detectMissedRun: slots node-cron dropped moments ago (2026-09-28)", () => {
  // node-cron 4 runs a tick only if its timer fires inside the slot's own second, so a
  // heartbeat 1 s late is dropped. A sweep must then see that slot, not the one before it.
  const slot = new Date("2026-09-24T14:00:00Z");
  const previousSlotRun = "2026-09-24T13:00:00.020Z"; // 13:00 ran on time
  const at = (offsetMs: number) => new Date(slot.getTime() + offsetMs);

  it.each([
    ["1 s", 1000],
    ["2 min", 2 * 60_000],
    ["4 min", 4 * 60_000],
  ])("recovers a slot that did not run, swept %s after it", (_label, offsetMs) => {
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt: previousSlotRun,
      now: at(offsetMs),
      isActive: false,
    });
    expect(missed?.toISOString()).toBe("2026-09-24T14:00:00.000Z");
  });

  it.each([
    ["1 s", 1000],
    ["2 min", 2 * 60_000],
    ["4 min", 4 * 60_000],
  ])("does not report a slot that ran, swept %s after it", (_label, offsetMs) => {
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt: "2026-09-24T14:00:00.015Z",
      now: at(offsetMs),
      isActive: false,
    });
    expect(missed).toBeNull();
  });

  it("does not count a run that started before the slot as that slot's run", () => {
    // A catch-up of 13:00 that started at 13:58 is not the 14:00 run (daemon E2E, 2026-09-28:
    // an every-minute job's 18:41 run hid the dropped 18:42 slot).
    expect(
      detectMissedRun({
        schedule: "0 * * * *",
        lastStartedAt: "2026-09-24T13:58:00.000Z",
        now: at(2 * 60_000),
        isActive: false,
      })?.toISOString(),
    ).toBe("2026-09-24T14:00:00.000Z");
    expect(
      detectMissedRun({
        schedule: "* * * * *",
        lastStartedAt: "2026-09-28T18:41:00.012Z",
        now: new Date("2026-09-28T18:42:25Z"),
        isActive: false,
      })?.toISOString(),
    ).toBe("2026-09-28T18:42:00.000Z");
  });

  it("leaves a slot under 1 s old alone: node-cron can still fire it", () => {
    const missed = detectMissedRun({
      schedule: "0 * * * *",
      lastStartedAt: previousSlotRun,
      now: at(999),
      isActive: false,
    });
    expect(missed).toBeNull();
  });

  it("ignores a slot from before notBefore (the job's cron task did not exist yet)", () => {
    const args = {
      schedule: "0 * * * *",
      lastStartedAt: previousSlotRun,
      now: at(2 * 60_000),
      isActive: false,
    };
    expect(
      detectMissedRun({ ...args, notBefore: at(30_000) }),
    ).toBeNull();
    expect(
      detectMissedRun({ ...args, notBefore: at(-60 * 60_000) })?.toISOString(),
    ).toBe("2026-09-24T14:00:00.000Z");
  });
});

describe("detectMissedRun: only slots node-cron itself would fire", () => {
  // cron-parser (which lists the slots) ORs day-of-month and day-of-week when both are
  // restricted, as standard cron does; node-cron 4, which fires them, ANDs them
  // (time-matcher.js: runOnDay && runOnWeekDay). A slot only cron-parser has never runs,
  // so the 30 s missed-tick check would turn each one into a catch-up (review, 2026-09-28).
  const require = createRequire(import.meta.url);
  // node-cron's exports map hides its internals; load the matcher its scheduler uses by path.
  const { TimeMatcher } = require(
    path.join(path.dirname(require.resolve("node-cron")), "time/time-matcher.js"),
  ) as { TimeMatcher: new (pattern: string) => { match: (d: Date) => boolean } };

  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "Europe/Prague";
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("does not report a day-of-month-only slot of a first-Monday schedule (0 9 1-7 * 1)", () => {
    const firstMondayOfSeptember = "2026-09-07T07:00:00.020Z"; // 09:00 Prague
    // Saturday 2026-10-03 09:00 Prague: day 3 is in 1-7, but it is not a Monday.
    expect(
      detectMissedRun({
        schedule: "0 9 1-7 * 1",
        lastStartedAt: firstMondayOfSeptember,
        now: new Date("2026-10-03T07:00:30Z"),
        isActive: false,
      }),
    ).toBeNull();
    // Monday 2026-10-05 09:00 Prague is a real slot.
    expect(
      detectMissedRun({
        schedule: "0 9 1-7 * 1",
        lastStartedAt: firstMondayOfSeptember,
        now: new Date("2026-10-05T07:02:00Z"),
        isActive: false,
      })?.toISOString(),
    ).toBe("2026-10-05T07:00:00.000Z");
  });

  /**
   * Simulate node-cron firing every slot its own TimeMatcher matches (the run starting 20 ms
   * later; from 24 h before the window, so the poll starts with a run on record) plus a
   * missed-tick poll every 5 min, as sweepMissedRuns + CatchupQueue dedupe run it. Returns
   * the slots the poll claimed. `drop` is a slot node-cron fails to fire.
   */
  const simulate = (schedule: string, fromIso: string, toIso: string, drop?: string) => {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    const matcher = new TimeMatcher(schedule);
    // Candidates from cron-parser (a superset: it ORs the day fields); node-cron's matcher
    // decides which of them fire. (Matching every minute instead costs ~0.1 ms a call.)
    // Walked with prev(): cron-parser 5's next() skips a slot on a DST-change day.
    const fires: number[] = [];
    const candidates = CronExpressionParser.parse(schedule, {
      currentDate: new Date(to),
      startDate: new Date(from - 24 * HOUR),
    });
    while (candidates.hasPrev()) {
      const slot = candidates.prev().toDate();
      if (matcher.match(slot) && slot.toISOString() !== drop) fires.push(slot.getTime());
    }
    fires.reverse();
    let next = 0;
    let lastStartedAt: string | null = null;
    let handled = -Infinity;
    const claimed: string[] = [];
    for (let t = from; t < to; t += 5 * 60_000) {
      const now = new Date(t + 15_000);
      for (; next < fires.length && fires[next] <= now.getTime(); next++) {
        lastStartedAt = new Date(fires[next] + 20).toISOString();
      }
      const missed = detectMissedRun({ schedule, lastStartedAt, now, isActive: false });
      if (missed && missed.getTime() > handled) {
        handled = missed.getTime();
        claimed.push(missed.toISOString());
        lastStartedAt = now.toISOString(); // the catch-up starts right away
      }
    }
    return claimed;
  };

  it.each([
    ["0 9 1-7 * 1"], // first Monday of the month
    ["0 9 1-31 * 1-5"], // day-of-month spelled out: node-cron still ANDs it
    ["30 8 1,15 * 5"], // the 1st/15th only when it is a Friday
    ["*/20 6-22 * * 1-5"], // control: one day field restricted, both libraries agree
    ["0 17 * * 0-4"], // control
  ])("claims no slot node-cron runs on its own or never fires: %s", (schedule) => {
    expect(simulate(schedule, "2026-09-28T00:00:00Z", "2026-10-18T00:00:00Z")).toEqual([]);
  });

  it("still claims a real first-Monday slot that node-cron dropped", () => {
    expect(
      simulate(
        "0 9 1-7 * 1",
        "2026-09-28T00:00:00Z",
        "2026-10-18T00:00:00Z",
        "2026-10-05T07:00:00.000Z",
      ),
    ).toEqual(["2026-10-05T07:00:00.000Z"]);
  });
});

describe("CatchupQueue", () => {
  it("enqueues a job and surfaces it in snapshot", () => {
    const q = new CatchupQueue({
      runCatchup: vi.fn().mockResolvedValue(undefined),
      isJobActive: () => false,
      jobName: () => "Test Job",
    });
    q.enqueue("job-a", new Date("2026-04-28T09:00:00Z"));
    const snap = q.snapshot();
    expect(snap.queued).toHaveLength(1);
    expect(snap.queued[0].jobId).toBe("job-a");
    expect(snap.queued[0].jobName).toBe("Test Job");
    expect(snap.queued[0].missedSlot).toBe("2026-04-28T09:00:00.000Z");
    expect(snap.inFlight).toBeNull();
  });

  it("dedupes by jobId, keeping the latest missedSlot", () => {
    const q = new CatchupQueue({
      runCatchup: vi.fn().mockResolvedValue(undefined),
      isJobActive: () => false,
      jobName: () => "X",
    });
    q.enqueue("job-a", new Date("2026-04-28T08:00:00Z"));
    q.enqueue("job-a", new Date("2026-04-28T09:00:00Z"));
    const snap = q.snapshot();
    expect(snap.queued).toHaveLength(1);
    expect(snap.queued[0].missedSlot).toBe("2026-04-28T09:00:00.000Z");
  });

  it("processes one job, then waits gapMs before processing the next", async () => {
    vi.useFakeTimers();
    const runCatchup = vi.fn().mockResolvedValue(undefined);
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => false,
      jobName: () => "X",
      gapMs: 1000,
    });
    q.enqueue("job-a", new Date("2026-04-28T09:00:00Z"));
    q.enqueue("job-b", new Date("2026-04-28T09:00:00Z"));

    q.process();
    await vi.waitFor(() => expect(runCatchup).toHaveBeenCalledTimes(1));
    expect(runCatchup).toHaveBeenCalledWith("job-a", expect.any(Date));

    // Before the gap elapses, the second job should not have started.
    await vi.advanceTimersByTimeAsync(500);
    expect(runCatchup).toHaveBeenCalledTimes(1);

    // After the gap elapses, the second job runs.
    await vi.advanceTimersByTimeAsync(600);
    expect(runCatchup).toHaveBeenCalledTimes(2);
    expect(runCatchup).toHaveBeenLastCalledWith("job-b", expect.any(Date));

    vi.useRealTimers();
  });

  it("skips a job that is currently active and revisits later", async () => {
    vi.useFakeTimers();
    let active = true;
    const runCatchup = vi.fn().mockResolvedValue(undefined);
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => active,
      jobName: () => "X",
      gapMs: 0,
    });
    q.enqueue("job-a", new Date("2026-04-28T09:00:00Z"));

    q.process();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCatchup).not.toHaveBeenCalled();
    expect(q.snapshot().queued).toHaveLength(1);

    active = false;
    q.process();
    await vi.waitFor(() => expect(runCatchup).toHaveBeenCalledTimes(1));
    expect(q.snapshot().queued).toHaveLength(0);

    vi.useRealTimers();
  });

  it("clears inFlight even if runCatchup rejects", async () => {
    const runCatchup = vi.fn().mockRejectedValue(new Error("boom"));
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => false,
      jobName: () => "X",
      gapMs: 0,
    });
    q.enqueue("job-a", new Date("2026-04-28T09:00:00Z"));
    q.process();
    await vi.waitFor(() => expect(runCatchup).toHaveBeenCalledTimes(1));
    // Allow microtasks to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(q.snapshot().inFlight).toBeNull();
    expect(q.snapshot().queued).toHaveLength(0);
  });
});

describe("CatchupQueue: one catch-up per slot", () => {
  it("accepts a slot once, whichever source reports it, and never after it ran", async () => {
    const runCatchup = vi.fn().mockResolvedValue(undefined);
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => false,
      jobName: () => "X",
      gapMs: 0,
    });
    const slot = new Date("2026-09-24T14:00:00Z");
    expect(q.enqueue("job-a", slot)).toBe(true);
    // The missed-tick check, the gap watcher and an overlapping tick can all report it.
    expect(q.enqueue("job-a", new Date(slot))).toBe(false);
    expect(q.enqueue("job-a", new Date("2026-09-24T13:00:00Z"))).toBe(false);
    expect(q.snapshot().queued).toHaveLength(1);

    q.process();
    await vi.waitFor(() => expect(runCatchup).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(q.enqueue("job-a", slot)).toBe(false);
    expect(q.snapshot().queued).toHaveLength(0);
    // The next slot is a new one.
    expect(q.enqueue("job-a", new Date("2026-09-24T15:00:00Z"))).toBe(true);
  });
});

describe("CatchupQueue: per-job catchup policy", () => {
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  const makeQueue = (
    policy: "always" | "same-day" | "never" | undefined,
    isJobActive: () => boolean = () => false,
  ) => {
    const runCatchup = vi.fn().mockResolvedValue(undefined);
    const q = new CatchupQueue({
      runCatchup,
      isJobActive,
      jobName: (id) => id,
      gapMs: 0,
      catchupPolicy: () => policy,
    });
    return { q, runCatchup };
  };

  it("same-day skips a catch-up that would start on a later local date (pre-meeting-prep, 2026-09-17)", async () => {
    process.env.TZ = "Europe/Prague";
    // The 17:00 slot of 09-16 ("prep TOMORROW's meetings"), caught up at 08:55 on 09-17.
    vi.setSystemTime(new Date("2026-09-17T06:55:21Z"));
    const { q, runCatchup } = makeQueue("same-day");
    expect(q.enqueue("pre-meeting-prep", new Date("2026-09-16T15:00:00Z"))).toBe(false);
    q.process();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCatchup).not.toHaveBeenCalled();
    expect(q.snapshot().queued).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/pre-meeting-prep.*same-day/),
    );
  });

  it("same-day runs a catch-up that starts on the slot's local date", async () => {
    process.env.TZ = "Europe/Prague";
    vi.setSystemTime(new Date("2026-09-16T16:30:00Z")); // 18:30, same evening
    const { q, runCatchup } = makeQueue("same-day");
    const slot = new Date("2026-09-16T15:00:00Z");
    expect(q.enqueue("pre-meeting-prep", slot)).toBe(true);
    q.process();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCatchup).toHaveBeenCalledWith("pre-meeting-prep", slot);
  });

  it("same-day compares calendar dates in the daemon's local timezone, not UTC", () => {
    // 22:30Z on 09-16 is 00:30 on 09-17 in Prague and 15:30 on 09-16 in Los Angeles.
    const slot = new Date("2026-09-16T22:30:00Z");
    vi.setSystemTime(new Date("2026-09-17T06:00:00Z")); // Prague 08:00 09-17, LA 23:00 09-16
    process.env.TZ = "Europe/Prague";
    expect(makeQueue("same-day").q.enqueue("job", slot)).toBe(true);
    process.env.TZ = "UTC";
    expect(makeQueue("same-day").q.enqueue("job", slot)).toBe(false);
    process.env.TZ = "America/Los_Angeles";
    expect(makeQueue("same-day").q.enqueue("job", slot)).toBe(true);
    vi.setSystemTime(new Date("2026-09-17T07:30:00Z")); // LA 00:30 09-17
    expect(makeQueue("same-day").q.enqueue("job", slot)).toBe(false);
  });

  it("same-day re-checks when the catch-up actually starts (the queue waited past midnight)", async () => {
    process.env.TZ = "Europe/Prague";
    vi.setSystemTime(new Date("2026-09-16T21:50:00Z")); // 23:50
    let active = true;
    const { q, runCatchup } = makeQueue("same-day", () => active);
    expect(q.enqueue("executive-review", new Date("2026-09-16T14:45:00Z"))).toBe(true);
    q.process(); // the job is still running: the entry waits
    vi.setSystemTime(new Date("2026-09-16T22:10:00Z")); // 00:10 the next day
    active = false;
    q.process();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCatchup).not.toHaveBeenCalled();
    expect(q.snapshot().queued).toEqual([]);
  });

  it("never skips every catch-up", async () => {
    vi.setSystemTime(new Date("2026-09-16T15:02:00Z"));
    const { q, runCatchup } = makeQueue("never");
    expect(q.enqueue("job", new Date("2026-09-16T15:00:00Z"))).toBe(false);
    q.process();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCatchup).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/job.*never/));
  });

  it.each([["always"], [undefined]] as const)(
    "%s keeps today's behaviour: a next-day catch-up still runs",
    async (policy) => {
      process.env.TZ = "Europe/Prague";
      vi.setSystemTime(new Date("2026-09-17T06:55:21Z"));
      const { q, runCatchup } = makeQueue(policy);
      expect(q.enqueue("job", new Date("2026-09-16T15:00:00Z"))).toBe(true);
      q.process();
      await vi.advanceTimersByTimeAsync(0);
      expect(runCatchup).toHaveBeenCalledTimes(1);
    },
  );
});

describe("CatchupQueue: a catch-up the job has run past is dropped (2026-09-29)", () => {
  // babysit-prs' 06:00Z slot was queued at 06:13Z behind five other catch-ups. Its own 07:00Z
  // tick could run first, and the stale catch-up still ran after it: two runs for one missed
  // slot. The job's newest run (any trigger, finished or not) decides.
  const slot = new Date("2026-09-29T06:00:00Z");

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeQueue = (newestRunStartedAt: (jobId: string) => string | null) => {
    const runCatchup = vi.fn().mockResolvedValue(undefined);
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => false,
      jobName: (id) => id,
      gapMs: 0,
      newestRunStartedAt,
    });
    return { q, runCatchup };
  };

  it.each([
    ["at the slot", "2026-09-29T06:00:00.000Z"],
    ["after the slot (its next scheduled tick)", "2026-09-29T07:00:00.015Z"],
    ["after the slot (a manual run)", "2026-09-29T06:20:00.000Z"],
  ])("drops it when the job's newest run started %s", async (_label, startedAt) => {
    const { q, runCatchup } = makeQueue(() => startedAt);
    expect(q.enqueue("babysit-prs", slot)).toBe(true);
    q.process();
    await new Promise((r) => setTimeout(r, 5));
    expect(runCatchup).not.toHaveBeenCalled();
    expect(q.snapshot().queued).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(
      `[catchup] Dropped babysit-prs catch-up for missed slot 2026-09-29T06:00:00.000Z: already covered by the run started ${startedAt}`,
    );
  });

  it.each([
    ["before the slot (a longer run that overlapped it)", "2026-09-29T05:59:59.999Z"],
    ["never", null],
  ])("keeps and runs it when the job's newest run started %s", async (_label, startedAt) => {
    const { q, runCatchup } = makeQueue(() => startedAt);
    q.enqueue("babysit-prs", slot);
    q.process();
    await vi.waitFor(() => expect(runCatchup).toHaveBeenCalledTimes(1));
    expect(runCatchup).toHaveBeenCalledWith("babysit-prs", slot);
  });

  it("drops a covered entry queued behind a busy head without waiting for the head", async () => {
    let finishHead!: () => void;
    const runCatchup = vi.fn((jobId: string) =>
      jobId === "head"
        ? new Promise<void>((r) => (finishHead = r))
        : Promise.resolve(),
    );
    const newest: Record<string, string | null> = {
      head: null,
      "babysit-prs": "2026-09-29T05:00:00.020Z",
    };
    const q = new CatchupQueue({
      runCatchup,
      isJobActive: () => false,
      jobName: (id) => id,
      gapMs: 0,
      newestRunStartedAt: (id) => newest[id] ?? null,
    });
    q.enqueue("head", new Date("2026-09-29T06:10:00Z"));
    q.enqueue("babysit-prs", slot);
    q.process();
    expect(q.snapshot().inFlight?.jobId).toBe("head");
    expect(q.snapshot().queued.map((e) => e.jobId)).toEqual(["babysit-prs"]);

    newest["babysit-prs"] = "2026-09-29T07:00:00.015Z"; // its 07:00 tick started (still running)
    q.process(); // any poke: another job's run ending, a sweep
    expect(q.snapshot().queued).toEqual([]);

    finishHead();
    await new Promise((r) => setTimeout(r, 5));
    expect(runCatchup.mock.calls.map(([id]) => id)).toEqual(["head"]);
  });
});

describe("sweepMissedRuns", () => {
  const queue = () =>
    new CatchupQueue({
      runCatchup: vi.fn().mockResolvedValue(undefined),
      isJobActive: () => false,
      jobName: (id) => id,
    });

  it("enqueues every enabled job whose previous slot was missed, and nothing else", () => {
    // The laptop closed at 17:08 the evening before; it is now 07:36 the next day.
    // approve-prs (:40) missed 06:40, babysit-prs (:00) missed 07:00, a disabled job
    // and an active job are left alone, a job that ran on time is left alone.
    const q = queue();
    const now = new Date("2026-09-25T05:36:00Z");
    const enqueued = sweepMissedRuns(
      {
        jobs: {
          "approve-prs": { schedule: "40 4-20 * * 1-5", enabled: true },
          "babysit-prs": { schedule: "0 4-20 * * 1-5", enabled: true },
          "disabled-job": { schedule: "0 * * * *", enabled: false },
          "active-job": { schedule: "0 * * * *", enabled: true },
          "on-time-job": { schedule: "30 * * * *", enabled: true },
        },
        now,
        lastStartedAt: (id) =>
          id === "on-time-job"
            ? "2026-09-25T05:31:00Z"
            : "2026-09-24T14:40:00Z",
        isActive: (id) => id === "active-job",
      },
      q,
    );
    expect(
      enqueued.map((e) => `${e.jobId}@${e.missedSlot.toISOString()}`).sort(),
    ).toEqual([
      "approve-prs@2026-09-25T04:40:00.000Z",
      "babysit-prs@2026-09-25T05:00:00.000Z",
    ]);
    expect(
      q
        .snapshot()
        .queued.map((e) => e.jobId)
        .sort(),
    ).toEqual(["approve-prs", "babysit-prs"]);
  });

  it("enqueues nothing when every job ran within tolerance", () => {
    const q = queue();
    const enqueued = sweepMissedRuns(
      {
        jobs: { hourly: { schedule: "0 * * * *", enabled: true } },
        now: new Date("2026-09-25T09:03:00Z"),
        lastStartedAt: () => "2026-09-25T09:00:30Z",
        isActive: () => false,
      },
      q,
    );
    expect(enqueued).toEqual([]);
    expect(q.snapshot().queued).toHaveLength(0);
  });

  it("skips slots from before notBefore (the job's cron task was registered after them)", () => {
    const args = {
      jobs: { hourly: { schedule: "0 * * * *", enabled: true } },
      now: new Date("2026-09-24T14:02:00Z"),
      lastStartedAt: () => "2026-09-24T13:00:00.020Z",
      isActive: () => false,
    };
    expect(
      sweepMissedRuns(
        { ...args, notBefore: () => new Date("2026-09-24T14:01:00Z") },
        queue(),
      ),
    ).toEqual([]);
    expect(
      sweepMissedRuns(
        { ...args, notBefore: () => new Date("2026-09-24T13:30:00Z") },
        queue(),
      ).map((e) => e.missedSlot.toISOString()),
    ).toEqual(["2026-09-24T14:00:00.000Z"]);
  });

  it("reports a missed slot once across repeated polls", () => {
    const q = queue();
    const poll = (now: string) =>
      sweepMissedRuns(
        {
          jobs: { hourly: { schedule: "0 * * * *", enabled: true } },
          now: new Date(now),
          lastStartedAt: () => "2026-09-24T13:00:00.020Z",
          isActive: () => false,
        },
        q,
      );
    expect(poll("2026-09-24T14:00:30Z").map((e) => e.jobId)).toEqual(["hourly"]);
    expect(poll("2026-09-24T14:01:00Z")).toEqual([]);
  });
});

describe("startGapWatcher", () => {
  it("stays quiet while the clock advances at the poll interval", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const onGap = vi.fn();
    const timer = startGapWatcher({
      onGap,
      intervalMs: 1000,
      gapMs: 5000,
      now: () => clock,
    });
    for (let i = 0; i < 10; i++) {
      clock += 1000;
      vi.advanceTimersByTime(1000);
    }
    expect(onGap).not.toHaveBeenCalled();
    clearInterval(timer);
    vi.useRealTimers();
  });

  it("fires once with the gap length when a poll arrives late (the machine slept)", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const onGap = vi.fn();
    const timer = startGapWatcher({
      onGap,
      intervalMs: 1000,
      gapMs: 5000,
      now: () => clock,
    });
    clock += 1000;
    vi.advanceTimersByTime(1000);
    // The next callback is delivered 14 hours late: the wall clock jumped, the timer did not.
    clock += 14 * 60 * 60 * 1000;
    vi.advanceTimersByTime(1000);
    expect(onGap).toHaveBeenCalledTimes(1);
    const [gapMs, now] = onGap.mock.calls[0];
    expect(gapMs).toBe(14 * 60 * 60 * 1000);
    expect(now.getTime()).toBe(clock);
    // Back to normal cadence: no further gaps.
    clock += 1000;
    vi.advanceTimersByTime(1000);
    expect(onGap).toHaveBeenCalledTimes(1);
    clearInterval(timer);
    vi.useRealTimers();
  });

  it("ignores lateness under the threshold (a busy event loop is not a sleep)", () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const onGap = vi.fn();
    const timer = startGapWatcher({
      onGap,
      intervalMs: 1000,
      gapMs: 5000,
      now: () => clock,
    });
    clock += 4000; // 3s late, under the 5s threshold
    vi.advanceTimersByTime(1000);
    expect(onGap).not.toHaveBeenCalled();
    clearInterval(timer);
    vi.useRealTimers();
  });
});

describe("CatchupQueue: covered entries never linger", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  // Head "head" stays in flight; "a" (uncovered) and "b" wait behind it.
  function busyQueue(newest: Record<string, string | null>) {
    const q = new CatchupQueue({
      runCatchup: (jobId: string) =>
        jobId === "head" ? new Promise<void>(() => {}) : Promise.resolve(),
      isJobActive: () => false,
      jobName: (id) => id,
      gapMs: 0,
      newestRunStartedAt: (id) => newest[id] ?? null,
    });
    q.enqueue("head", new Date("2026-09-29T06:10:00Z"));
    q.enqueue("a", new Date("2026-09-29T06:00:00Z"));
    q.enqueue("b", new Date("2026-09-29T06:00:00Z"));
    q.process();
    return q;
  }

  it("drops every covered entry, including one behind an uncovered entry, while the head is busy", () => {
    const newest: Record<string, string | null> = { head: null, a: null, b: null };
    const q = busyQueue(newest);
    newest.b = "2026-09-29T07:00:00.010Z"; // b's 07:00 tick ran
    q.process();
    expect(q.snapshot().queued.map((e) => e.jobId)).toEqual(["a"]);
  });

  it("does not report a covered entry as queued, even before the next poke", () => {
    const newest: Record<string, string | null> = { head: null, a: null, b: null };
    const q = busyQueue(newest);
    newest.b = "2026-09-29T07:00:00.010Z"; // covering run still going; nothing pokes the queue
    expect(q.snapshot().queued.map((e) => e.jobId)).toEqual(["a"]);
  });
});

