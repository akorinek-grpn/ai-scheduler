import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuns, type CatchupQueueSnapshot, type RunResponse } from "../api-client";
import {
  catchupDelayMs,
  describeCatchup,
  formatDelay,
  formatSlot,
  inFlightCatchupRun,
  isCatchupRun,
  pendingCatchupCount,
  recentCatchupRuns,
} from "../catchup-runs";

// Local-time constructors keep these tests independent of the machine's time zone.
// 2026-09-29 is a Tuesday.
const local = (
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  year = 2026,
): string => new Date(year, month - 1, day, hour, minute).toISOString();
const NOW = Date.parse(local(9, 29, 10, 0));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function run(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    jobId: "daily-check",
    runId: "run-1",
    jobName: "Daily Check",
    directory: "/tmp",
    status: "success",
    trigger: "scheduled",
    startedAt: local(9, 29, 8, 0),
    finishedAt: local(9, 29, 8, 5),
    exitCode: 0,
    cost: {
      currency: "USD",
      totalCostUsd: null,
      executionCostUsd: null,
      evaluationCostUsd: null,
      coverage: "unavailable",
      evaluationState: "unavailable",
      attempts: [],
      evaluation: null,
      tokens: null,
    },
    ...overrides,
  };
}

describe("isCatchupRun", () => {
  it("is true only for the catchup trigger", () => {
    expect(isCatchupRun(run({ trigger: "catchup" }))).toBe(true);
    expect(isCatchupRun(run({ trigger: "scheduled" }))).toBe(false);
    expect(isCatchupRun(run({ trigger: "manual" }))).toBe(false);
  });
});

describe("catchupDelayMs", () => {
  it("measures from the missed slot to when the catch-up started", () => {
    expect(
      catchupDelayMs({
        catchupFor: "2026-09-28T09:05:00.000Z",
        startedAt: "2026-09-29T08:14:00.000Z",
      }),
    ).toBe(23 * HOUR + 9 * MINUTE);
  });

  it("is null when the slot is missing, unparseable or after the start", () => {
    expect(
      catchupDelayMs({ startedAt: "2026-09-29T08:14:00.000Z" }),
    ).toBeNull();
    expect(
      catchupDelayMs({
        catchupFor: "not a date",
        startedAt: "2026-09-29T08:14:00.000Z",
      }),
    ).toBeNull();
    expect(
      catchupDelayMs({
        catchupFor: "2026-09-29T09:00:00.000Z",
        startedAt: "2026-09-29T08:14:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("formatDelay", () => {
  it.each([
    [0, "0s"],
    [45 * 1000, "45s"],
    [59_999, "59s"],
    [MINUTE, "1m"],
    [12 * MINUTE + 30_000, "12m"],
    [3 * HOUR, "3h"],
    [3 * HOUR + 5 * MINUTE, "3h 5m"],
    [23 * HOUR + 9 * MINUTE, "23h 9m"],
    [DAY, "1d"],
    [DAY + 2 * HOUR + 40 * MINUTE, "1d 2h"],
    [3 * DAY + 5 * MINUTE, "3d"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDelay(ms)).toBe(expected);
  });

  it("never shows a negative delay", () => {
    expect(formatDelay(-5000)).toBe("0s");
  });
});

describe("formatSlot", () => {
  it("uses the weekday and 24-hour local time within the past week", () => {
    expect(formatSlot(local(9, 28, 9, 5), NOW)).toBe("Mon 09:05");
    expect(formatSlot(local(9, 29, 0, 30), NOW)).toBe("Tue 00:30");
    expect(formatSlot(local(9, 23, 23, 59), NOW)).toBe("Wed 23:59");
  });

  it("adds the date once the weekday alone would be ambiguous", () => {
    expect(formatSlot(local(9, 22, 9, 0), NOW)).toBe("Tue Sep 22 09:00");
    expect(formatSlot(local(9, 30, 9, 0), NOW)).toBe("Wed Sep 30 09:00");
  });

  it("adds the year for a slot in another year", () => {
    expect(formatSlot(local(12, 31, 18, 0, 2025), NOW)).toBe(
      "Wed Dec 31 2025 18:00",
    );
  });

  it("says so when the time cannot be read", () => {
    expect(formatSlot("garbage", NOW)).toBe("unknown time");
  });
});

describe("describeCatchup", () => {
  it("names the missed slot and how late the catch-up started", () => {
    expect(
      describeCatchup(
        { catchupFor: local(9, 28, 9, 5), startedAt: local(9, 29, 8, 14) },
        NOW,
      ),
    ).toBe("Catch-up of the missed Mon 09:05 run, started 23h 9m late");
  });

  it("falls back when the slot or the delay is unknown", () => {
    expect(describeCatchup({ startedAt: local(9, 29, 8, 14) }, NOW)).toBe(
      "Catch-up of a missed scheduled run",
    );
    expect(
      describeCatchup(
        { catchupFor: local(9, 29, 9, 0), startedAt: local(9, 29, 8, 14) },
        NOW,
      ),
    ).toBe("Catch-up of the missed Tue 09:00 run");
  });
});

describe("recentCatchupRuns", () => {
  const catchup = (runId: string, startedAt: string): RunResponse =>
    run({
      runId,
      trigger: "catchup",
      startedAt,
      catchupFor: local(9, 20, 9, 0),
    });

  it("keeps catch-ups started in the last 7 days, newest first", () => {
    const runs = [
      catchup("old", new Date(NOW - 7 * DAY - MINUTE).toISOString()),
      catchup("edge", new Date(NOW - 7 * DAY).toISOString()),
      run({ runId: "scheduled", startedAt: local(9, 29, 9, 0) }),
      catchup("yesterday", local(9, 28, 12, 0)),
      run({
        runId: "manual",
        trigger: "manual",
        startedAt: local(9, 29, 9, 30),
      }),
      catchup("today", local(9, 29, 7, 0)),
      catchup("unreadable", "garbage"),
    ];
    expect(recentCatchupRuns(runs, NOW).map((r) => r.runId)).toEqual([
      "today",
      "yesterday",
      "edge",
    ]);
  });

  it("lists a run once when it arrives from both the catch-up and the recent-runs fetch", () => {
    const today = catchup("today", local(9, 29, 7, 0));
    const other = {
      ...catchup("today", local(9, 29, 6, 0)),
      jobId: "other-job",
    };
    expect(
      recentCatchupRuns([today, other, { ...today }], NOW).map(
        (r) => `${r.jobId}/${r.runId}`,
      ),
    ).toEqual(["daily-check/today", "other-job/today"]);
  });
});

describe("pendingCatchupCount", () => {
  it("counts queued catch-ups plus the one in flight", () => {
    const queue: CatchupQueueSnapshot = {
      queued: [
        {
          jobId: "a",
          jobName: "A",
          missedSlot: local(9, 29, 9, 0),
          enqueuedAt: local(9, 29, 9, 1),
        },
        {
          jobId: "b",
          jobName: "B",
          missedSlot: local(9, 29, 9, 0),
          enqueuedAt: local(9, 29, 9, 1),
        },
      ],
      inFlight: { jobId: "c", jobName: "C", startedAt: local(9, 29, 9, 2) },
    };
    expect(pendingCatchupCount(queue)).toBe(3);
    expect(pendingCatchupCount({ ...queue, inFlight: null })).toBe(2);
    expect(pendingCatchupCount({ queued: [], inFlight: queue.inFlight })).toBe(
      1,
    );
  });

  it("is zero for an empty, missing or malformed queue", () => {
    expect(pendingCatchupCount({ queued: [], inFlight: null })).toBe(0);
    expect(pendingCatchupCount(null)).toBe(0);
    expect(pendingCatchupCount({} as CatchupQueueSnapshot)).toBe(0);
  });
});

describe("inFlightCatchupRun", () => {
  it("finds the running catch-up of the in-flight job", () => {
    const live = run({
      runId: "live",
      trigger: "catchup",
      status: "running",
      catchupFor: local(9, 28, 9, 5),
    });
    const runs = [
      run({ runId: "scheduled-live", status: "running" }),
      run({ runId: "done", trigger: "catchup" }),
      run({
        runId: "other-job",
        jobId: "other",
        trigger: "catchup",
        status: "running",
      }),
      live,
    ];
    expect(
      inFlightCatchupRun(runs, {
        jobId: "daily-check",
        jobName: "Daily Check",
        startedAt: local(9, 29, 9, 0),
      }),
    ).toBe(live);
    expect(inFlightCatchupRun(runs, null)).toBeNull();
    expect(
      inFlightCatchupRun([], {
        jobId: "daily-check",
        jobName: "Daily Check",
        startedAt: local(9, 29, 9, 0),
      }),
    ).toBeNull();
  });
});

describe("getRuns trigger parameter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the trigger filter along with the other filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    await getRuns({ job: "daily-check", trigger: "catchup", limit: 50 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/runs?job=daily-check&trigger=catchup&limit=50");
  });
});
