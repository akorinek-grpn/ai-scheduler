/**
 * The Claude account's usage window (2026-10-16). When the subscription's 5-hour ("session")
 * or 7-day ("weekly") limit is exhausted, `claude -p` prints one line and exits 1:
 *
 *   You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)
 *   You've hit your weekly limit · resets 7am (Europe/Prague)
 *   You've hit your session limit · resets 12:30pm (Europe/Prague)
 *
 * Every Claude job on the Mac fails the same way until the reset (fourteen Air runs across four
 * jobs on 2026-10-16 06:00-09:50Z). This module recognises the text and turns the reset into an
 * instant; the engine holds the Mac's Claude jobs until then (cron-engine.ts usage hold).
 * Pure functions, no I/O.
 */
import type { UsageLimitHit } from "@shared/types";

// "resets <when>" runs to the zone's "(" or the end of the line; the zone is an IANA name.
const LIMIT_RE =
  /You.ve hit your (weekly|session) limit(?:\s*[·•–—-]\s*resets\s+([^()\n]+))?(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+)\))?/i;

const WHEN_RE = /^(?:([A-Za-z]{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Seconds added to the reset so the first run after it never lands a hair early. */
export const HOLD_MARGIN_MS = 60_000;
/** Hold when the reset in the text could not be read: short, the next failure re-arms it. */
export const HOLD_UNPARSED_MS = 30 * 60_000;

function zoneIsValid(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number; // 0-11
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in `zone` at `instant`. */
function wallClockIn(zone: string, instant: Date): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    // Some ICU builds print 24 for midnight even with h23.
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `zone` from UTC, in minutes, at `instant` (CEST = 120). */
function offsetMinutes(zone: string, instant: Date): number {
  const w = wallClockIn(zone, instant);
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which the wall clock in `zone` reads the given local time. Iterates on the
 * zone's offset, so a reset on the far side of a DST change lands on the right UTC hour.
 */
export function instantFromWallClock(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wall = Date.UTC(year, month, day, hour, minute, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - offsetMinutes(zone, new Date(guess)) * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/**
 * The reset instant named by the text after "resets": `Oct 18 at 5am` (that date, the next
 * occurrence of it), `7am` or `12:30pm` (today in the zone if still ahead, else tomorrow).
 * null when the words or the zone are not understood.
 */
export function parseResetTime(when: string, zone: string, now: Date): Date | null {
  const m = WHEN_RE.exec(when.trim());
  if (!m || !zoneIsValid(zone)) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem] = m;
  const hour12 = Number(hourText);
  if (hour12 < 1 || hour12 > 12) return null;
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  const today = wallClockIn(zone, now);

  if (monthName) {
    const month = MONTHS[monthName.toLowerCase()];
    if (month === undefined) return null;
    const day = Number(dayText);
    if (day < 1 || day > 31) return null;
    let instant = instantFromWallClock(zone, today.year, month, day, hour, minute);
    // A date more than a day in the past names next year's (a text read on Dec 30 for Jan 2).
    if (instant.getTime() < now.getTime() - 24 * 3_600_000) {
      instant = instantFromWallClock(zone, today.year + 1, month, day, hour, minute);
    }
    return instant;
  }

  let instant = instantFromWallClock(zone, today.year, today.month, today.day, hour, minute);
  if (instant.getTime() <= now.getTime()) {
    instant = instantFromWallClock(zone, today.year, today.month, today.day + 1, hour, minute);
  }
  return instant;
}

/**
 * The usage-limit line in a run's output, if any, with its reset resolved against `now`.
 * The text is kept verbatim (trimmed) so the evaluation and the hold can quote it.
 */
export function detectUsageLimit(output: string, now: Date = new Date()): UsageLimitHit | null {
  const m = LIMIT_RE.exec(output);
  if (!m) return null;
  const [text, kindText, when, zone] = m;
  const kind = kindText.toLowerCase() === "weekly" ? "weekly" : "session";
  const resetsAt = when && zone ? parseResetTime(when.trim(), zone, now) : null;
  return {
    kind,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    zone: zone ?? null,
    text: text.trim(),
  };
}

/** When the hold for `hit` ends: the reset plus a minute, or 30 minutes when it is unknown. */
export function holdUntil(hit: Pick<UsageLimitHit, "resetsAt">, now: Date = new Date()): Date {
  const resetMs = hit.resetsAt ? Date.parse(hit.resetsAt) : NaN;
  if (Number.isFinite(resetMs) && resetMs > now.getTime()) {
    return new Date(resetMs + HOLD_MARGIN_MS);
  }
  return new Date(now.getTime() + HOLD_UNPARSED_MS);
}
