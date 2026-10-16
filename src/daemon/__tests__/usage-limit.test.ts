import { describe, it, expect } from "vitest";
import { detectUsageLimit, holdUntil, parseResetTime } from "../usage-limit";

// The three limit texts seen in run logs on both Macs up to 2026-10-16, resolved against a
// clock in Europe/Prague (CEST, UTC+2, until 2026-10-25 03:00; CET, UTC+1, after).

describe("parseResetTime", () => {
  const now = new Date("2026-10-16T06:00:00Z"); // 08:00 CEST

  it("reads a dated reset in the zone's wall clock", () => {
    expect(parseResetTime("Oct 18 at 5am", "Europe/Prague", now)?.toISOString()).toBe(
      "2026-10-18T03:00:00.000Z",
    );
  });

  it("reads a same-day time still ahead as today", () => {
    expect(parseResetTime("12:30pm", "Europe/Prague", now)?.toISOString()).toBe(
      "2026-10-16T10:30:00.000Z",
    );
  });

  it("reads a time already behind as tomorrow", () => {
    expect(parseResetTime("7am", "Europe/Prague", now)?.toISOString()).toBe(
      "2026-10-17T05:00:00.000Z",
    );
  });

  it("lands on the right UTC hour across the DST change", () => {
    const beforeChange = new Date("2026-10-24T10:00:00Z"); // CEST
    expect(parseResetTime("Oct 26 at 5am", "Europe/Prague", beforeChange)?.toISOString()).toBe(
      "2026-10-26T04:00:00.000Z", // CET
    );
    const lateEvening = new Date("2026-10-24T23:30:00Z"); // 01:30 CEST on the 25th
    expect(parseResetTime("5am", "Europe/Prague", lateEvening)?.toISOString()).toBe(
      "2026-10-25T04:00:00.000Z", // after the 03:00 fall-back, 05:00 CET
    );
  });

  it("takes a date behind the clock as next year's", () => {
    const yearEnd = new Date("2026-12-30T10:00:00Z");
    expect(parseResetTime("Jan 2 at 5am", "Europe/Prague", yearEnd)?.toISOString()).toBe(
      "2027-01-02T04:00:00.000Z",
    );
  });

  it("rejects words or zones it does not understand", () => {
    expect(parseResetTime("soon", "Europe/Prague", now)).toBeNull();
    expect(parseResetTime("Oct 18 at 5am", "Mars/Olympus", now)).toBeNull();
    expect(parseResetTime("13pm", "Europe/Prague", now)).toBeNull();
  });
});

describe("detectUsageLimit", () => {
  const now = new Date("2026-10-16T06:00:00Z");

  it("finds the weekly limit with a date and resolves its reset", () => {
    const output =
      "...\nYou've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)\n=== giving up after 1 attempt ===\n";
    expect(detectUsageLimit(output, now)).toEqual({
      kind: "weekly",
      resetsAt: "2026-10-18T03:00:00.000Z",
      zone: "Europe/Prague",
      text: "You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)",
    });
  });

  it("finds the weekly limit with a same-day reset", () => {
    expect(detectUsageLimit("You've hit your weekly limit · resets 7am (Europe/Prague)", now)).toMatchObject({
      kind: "weekly",
      resetsAt: "2026-10-17T05:00:00.000Z",
    });
  });

  it("finds the session limit", () => {
    expect(detectUsageLimit("stderr: You've hit your session limit · resets 12:30pm (Europe/Prague)\n", now)).toMatchObject({
      kind: "session",
      resetsAt: "2026-10-16T10:30:00.000Z",
      zone: "Europe/Prague",
    });
  });

  it("keeps the hit but no reset when the words after 'resets' are new", () => {
    expect(detectUsageLimit("You've hit your weekly limit · resets at some point (Europe/Prague)", now)).toMatchObject({
      kind: "weekly",
      resetsAt: null,
    });
  });

  it("ignores ordinary output, including the phrase quoted in a document", () => {
    expect(detectUsageLimit("Reviewed 3 PRs; nothing hit a limit today.", now)).toBeNull();
    expect(detectUsageLimit("", now)).toBeNull();
  });
});

describe("holdUntil", () => {
  const now = new Date("2026-10-16T06:00:00Z");

  it("ends a minute after the reset", () => {
    expect(holdUntil({ resetsAt: "2026-10-18T03:00:00.000Z" }, now).toISOString()).toBe(
      "2026-10-18T03:01:00.000Z",
    );
  });

  it("holds 30 minutes when the reset is unknown or already behind", () => {
    expect(holdUntil({ resetsAt: null }, now).toISOString()).toBe("2026-10-16T06:30:00.000Z");
    expect(holdUntil({ resetsAt: "2026-10-16T05:00:00.000Z" }, now).toISOString()).toBe(
      "2026-10-16T06:30:00.000Z",
    );
  });
});
