import type {
  CatchupQueueInFlight,
  CatchupQueueSnapshot,
  RunResponse,
} from "./api-client";

/** Catch-up ("retrospective") runs: the daemon re-ran a scheduled slot it missed. */

export const CATCHUP_WINDOW_DAYS = 7;
/** The Runs page filtered to catch-up runs; the sidebar pill and the dashboard panel link here. */
export const CATCHUP_RUNS_HREF = "/runs?trigger=catchup";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function isCatchupRun(run: Pick<RunResponse, "trigger">): boolean {
  return run.trigger === "catchup";
}

/** How long after the missed slot the catch-up started; null when the slot is unknown or inconsistent. */
export function catchupDelayMs(
  run: Pick<RunResponse, "catchupFor" | "startedAt">,
): number | null {
  if (!run.catchupFor) return null;
  const slot = Date.parse(run.catchupFor);
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(slot) || !Number.isFinite(started) || started < slot)
    return null;
  return started - slot;
}

/** Compact, floored duration: "45s", "12m", "3h 5m", "1d 2h". */
export function formatDelay(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE_MS) return `${Math.floor(safe / 1000)}s`;
  if (safe < HOUR_MS) return `${Math.floor(safe / MINUTE_MS)}m`;
  if (safe < DAY_MS) {
    const hours = Math.floor(safe / HOUR_MS);
    const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(safe / DAY_MS);
  const hours = Math.floor((safe % DAY_MS) / HOUR_MS);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const pad = (value: number): string => value.toString().padStart(2, "0");

/**
 * A slot in local time: "Mon 09:05" while the weekday alone is unambiguous (today and the
 * six days before), otherwise "Tue Sep 22 09:00", with the year when it is not this year.
 */
export function formatSlot(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown time";
  const today = new Date(now);
  const dayMidnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  // Rounded so a DST change (23- or 25-hour day) still counts as one day.
  const daysAgo = Math.round((todayMidnight - dayMidnight) / DAY_MS);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const weekday = WEEKDAYS[date.getDay()];
  if (daysAgo >= 0 && daysAgo <= 6) return `${weekday} ${time}`;
  const year =
    date.getFullYear() === today.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${weekday} ${MONTHS[date.getMonth()]} ${date.getDate()}${year} ${time}`;
}

/** Sentence for a catch-up badge: which slot it caught up and how late it started. */
export function describeCatchup(
  run: Pick<RunResponse, "catchupFor" | "startedAt">,
  now: number = Date.now(),
): string {
  if (!run.catchupFor || !Number.isFinite(Date.parse(run.catchupFor)))
    return "Catch-up of a missed scheduled run";
  const delay = catchupDelayMs(run);
  const slot = `Catch-up of the missed ${formatSlot(run.catchupFor, now)} run`;
  return delay === null ? slot : `${slot}, started ${formatDelay(delay)} late`;
}

/**
 * Catch-up runs started in the last `days` days, newest first. Filters client-side because a
 * daemon started before the `trigger` query parameter existed ignores it; runs that arrive from
 * more than one fetch are listed once.
 */
export function recentCatchupRuns(
  runs: RunResponse[],
  now: number = Date.now(),
  days: number = CATCHUP_WINDOW_DAYS,
): RunResponse[] {
  const since = now - days * DAY_MS;
  const seen = new Set<string>();
  const recent: RunResponse[] = [];
  for (const run of runs) {
    const key = `${run.jobId}/${run.runId}`;
    if (
      !isCatchupRun(run) ||
      seen.has(key) ||
      !(Date.parse(run.startedAt) >= since)
    )
      continue;
    seen.add(key);
    recent.push(run);
  }
  return recent.sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
}

/** Catch-ups waiting in the queue plus the one running now. */
export function pendingCatchupCount(
  queue: CatchupQueueSnapshot | null | undefined,
): number {
  if (!queue) return 0;
  const queued = Array.isArray(queue.queued) ? queue.queued.length : 0;
  return queued + (queue.inFlight ? 1 : 0);
}

/** The run record of the in-flight catch-up (the queue runs one at a time), for its missed slot and link. */
export function inFlightCatchupRun(
  runs: RunResponse[],
  inFlight: CatchupQueueInFlight | null | undefined,
): RunResponse | null {
  if (!inFlight) return null;
  return (
    runs.find(
      (run) =>
        run.jobId === inFlight.jobId &&
        isCatchupRun(run) &&
        run.status === "running",
    ) ?? null
  );
}
