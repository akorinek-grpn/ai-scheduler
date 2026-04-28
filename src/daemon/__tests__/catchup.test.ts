import { describe, it, expect } from "vitest";
import { detectMissedRun } from "../catchup";

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
