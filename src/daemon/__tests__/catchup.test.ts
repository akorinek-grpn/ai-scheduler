import { describe, it, expect, vi } from "vitest";
import { detectMissedRun, CatchupQueue } from "../catchup";

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
    const now = new Date("2026-04-28T10:01:00Z");
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
