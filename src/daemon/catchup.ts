import { CronExpressionParser, type CronFieldCollection } from "cron-parser";

import type {
  CatchupPolicy,
  CatchupQueueSnapshot,
  CatchupQueueEntry,
  CatchupQueueInFlight,
} from "@shared/types";

export interface DetectMissedRunArgs {
  schedule: string;
  lastStartedAt: string | null;
  now: Date;
  isActive: boolean;
  /** Ignore slots before this instant (the missed-tick check passes when the job's cron task was scheduled). */
  notBefore?: Date | null;
}

// node-cron 4 runs a slot only if its timer fires inside the slot's own second (runner.js
// matches the wall clock truncated to the second); a heartbeat 1 s late is dropped and
// never replayed. So from 1 s after a slot, a slot that has not started never will, and
// before that node-cron may still be about to start it. Until 2026-09-28 the look-back
// was offset by a 5-minute tolerance instead, so a sweep 1 s-5 min after a dropped slot
// resolved to the slot BEFORE it, which had run, and the dropped one was never caught up.
const SLOT_SETTLE_MS = 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** node-cron 4's TimeMatcher.match: every field must match, in the daemon's local time. */
function nodeCronFires(fields: CronFieldCollection, slot: Date): boolean {
  const has = (values: readonly (number | string)[], value: number) =>
    values.includes(value);
  return (
    has(fields.second.values, slot.getSeconds()) &&
    has(fields.minute.values, slot.getMinutes()) &&
    has(fields.hour.values, slot.getHours()) &&
    has(fields.dayOfMonth.values, slot.getDate()) &&
    has(fields.month.values, slot.getMonth() + 1) &&
    has(fields.dayOfWeek.values, slot.getDay())
  );
}

export function detectMissedRun(args: DetectMissedRunArgs): Date | null {
  if (args.isActive) return null;

  const nowMs = args.now.getTime();
  let prev: Date | null = null;
  try {
    // prev() is strictly before currentDate; +1 lets a slot exactly SLOT_SETTLE_MS old count.
    const refDate = new Date(nowMs - SLOT_SETTLE_MS + 1);
    const parser = CronExpressionParser.parse(args.schedule, {
      currentDate: refDate,
    });
    // The latest slot node-cron itself fires. cron-parser follows standard cron and ORs
    // day-of-month and day-of-week when both are restricted ("0 9 1-7 * 1": days 1-7 and
    // every Monday); node-cron 4 ANDs all fields (time-matcher.js), so it fires only the
    // first Monday. A slot only cron-parser lists never runs, so it is not a missed one.
    for (
      let slot = parser.prev().toDate();
      nowMs - slot.getTime() <= MAX_LOOKBACK_MS;
      slot = parser.prev().toDate()
    ) {
      if (nodeCronFires(parser.fields, slot)) {
        prev = slot;
        break;
      }
    }
  } catch {
    return null;
  }

  if (!prev) return null;
  if (args.notBefore && prev.getTime() < args.notBefore.getTime()) return null;

  const lastMs = args.lastStartedAt
    ? new Date(args.lastStartedAt).getTime()
    : 0;
  // A slot's own run starts at or after it (node-cron fires within the slot's second, a
  // catch-up later). A run that started before the slot - the previous slot's run, a
  // catch-up or a manual trigger - is not that slot's run. (Until 2026-09-28 one that
  // started up to 5 min before counted, which hid a dropped slot right after it.)
  if (prev.getTime() <= lastMs) return null;

  return prev;
}

export interface MissedRunSweepArgs {
  jobs: Record<string, { schedule: string; enabled: boolean }>;
  now: Date;
  lastStartedAt: (jobId: string) => string | null;
  isActive: (jobId: string) => boolean;
  /** Per-job DetectMissedRunArgs.notBefore; null means no lower bound. */
  notBefore?: (jobId: string) => Date | null;
}

export interface MissedRunSweepEntry {
  jobId: string;
  missedSlot: Date;
}

/**
 * Run detectMissedRun over every enabled job and enqueue what it finds. Used at
 * daemon startup and, since 2026-09-25, after a clock gap (see startGapWatcher):
 * a laptop that sleeps with the daemon alive fires no cron ticks, and node-cron
 * does not replay them on wake. Before this, a PR pushed at 17:14 the evening the
 * lid closed waited until the next morning's first cron edge (hub-tools#113).
 * Since 2026-09-28 also every 30 s, bounded by notBefore, for ticks node-cron dropped
 * while awake (index.ts missed-tick check).
 */
export function sweepMissedRuns(
  args: MissedRunSweepArgs,
  queue: CatchupQueue,
): MissedRunSweepEntry[] {
  const enqueued: MissedRunSweepEntry[] = [];
  for (const [jobId, jobConfig] of Object.entries(args.jobs)) {
    if (!jobConfig.enabled) continue;
    const missed = detectMissedRun({
      schedule: jobConfig.schedule,
      lastStartedAt: args.lastStartedAt(jobId),
      now: args.now,
      isActive: args.isActive(jobId),
      notBefore: args.notBefore?.(jobId) ?? null,
    });
    // enqueue refuses a slot already queued or skipped, so repeated polls report it once.
    if (missed && queue.enqueue(jobId, missed)) {
      enqueued.push({ jobId, missedSlot: missed });
    }
  }
  return enqueued;
}

export interface GapWatcherDeps {
  /** Called once per detected gap with the gap length and the current time. */
  onGap: (gapMs: number, now: Date) => void;
  /** Poll interval. Default 30s. */
  intervalMs?: number;
  /** A poll that arrives later than intervalMs + gapMs is a gap. Default 3 min. */
  gapMs?: number;
  /** Clock source, injectable for tests. */
  now?: () => number;
}

const DEFAULT_WATCH_INTERVAL_MS = 30_000;
const DEFAULT_GAP_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * Detect a suspended process (sleep, SIGSTOP, a frozen VM) by the only signal it
 * leaves: a setInterval callback that arrives far later than scheduled. Returns the
 * timer so the caller can clear it on shutdown.
 */
export function startGapWatcher(deps: GapWatcherDeps): NodeJS.Timeout {
  const intervalMs = deps.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const gapMs = deps.gapMs ?? DEFAULT_GAP_THRESHOLD_MS;
  const clock = deps.now ?? (() => Date.now());
  let last = clock();
  const timer = setInterval(() => {
    const now = clock();
    const late = now - last - intervalMs;
    last = now;
    if (late > gapMs) deps.onGap(late + intervalMs, new Date(now));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export interface CatchupQueueDeps {
  runCatchup: (jobId: string, missedSlot: Date) => Promise<void>;
  isJobActive: (jobId: string) => boolean;
  jobName: (jobId: string) => string;
  /** The job's scheduler.yaml `catchup` policy; undefined means "always". */
  catchupPolicy?: (jobId: string) => CatchupPolicy | undefined;
  /**
   * Start time (ISO) of the job's most recently started run of any trigger, including one
   * still running; null if none. Without it, queued entries are never dropped as covered.
   */
  newestRunStartedAt?: (jobId: string) => string | null;
  /**
   * Awaited before each catch-up starts (network-gate.ts waitForNetwork); its result is
   * ignored and a rejection is logged, so the catch-up runs either way. Without it, catch-ups
   * start at once.
   */
  waitForNetwork?: () => Promise<unknown>;
  gapMs?: number;
}

/** A catch-up that starts within this long of a finished network wait needs no new wait. */
const NETWORK_WAIT_FRESH_MS = 5_000;

interface PendingEntry {
  jobId: string;
  missedSlot: Date;
  enqueuedAt: Date;
}

interface InFlightEntry {
  jobId: string;
  startedAt: Date;
}

const DEFAULT_GAP_MS = 60_000;

/** YYYY-MM-DD in the daemon's local timezone, the one node-cron schedules are read in. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class CatchupQueue {
  private pending = new Map<string, PendingEntry>();
  /** Latest slot per job already queued or skipped: a slot gets at most one catch-up. */
  private handled = new Map<string, number>();
  private inFlight: InFlightEntry | null = null;
  private gapMs: number;
  private gapTimer: NodeJS.Timeout | null = null;
  private networkWait: Promise<void> | null = null;
  private networkWaitEndedAt: number | null = null;

  constructor(private deps: CatchupQueueDeps) {
    this.gapMs = deps.gapMs ?? DEFAULT_GAP_MS;
  }

  /**
   * Queue a catch-up run for `missedSlot`. Returns false and queues nothing when this slot
   * (or a later one) was already queued or skipped for the job - the startup sweep, the gap
   * and missed-tick checks and an overlapping tick can all report the same slot - or when
   * the job's `catchup` policy rules it out (logged).
   */
  enqueue(jobId: string, missedSlot: Date): boolean {
    const slotMs = missedSlot.getTime();
    const handled = this.handled.get(jobId);
    if (handled !== undefined && slotMs <= handled) return false;
    this.handled.set(jobId, slotMs);
    if (!this.policyAllowsNow(jobId, missedSlot)) return false;

    const existing = this.pending.get(jobId);
    this.pending.set(jobId, {
      jobId,
      missedSlot,
      enqueuedAt: existing?.enqueuedAt ?? new Date(),
    });
    return true;
  }

  /** Applies the job's `catchup` policy to a catch-up that would start now; logs a skip. */
  private policyAllowsNow(jobId: string, missedSlot: Date): boolean {
    const policy = this.deps.catchupPolicy?.(jobId) ?? "always";
    if (policy === "always") return true;
    const startDate = localDate(new Date());
    const slotDate = localDate(missedSlot);
    if (policy === "same-day" && startDate === slotDate) return true;
    console.log(
      `[catchup] Skipped ${jobId} catch-up for missed slot ${missedSlot.toISOString()}: catchup: ${policy}` +
        (policy === "same-day"
          ? ` and it would start on ${startDate}, not the slot's ${slotDate}`
          : ""),
    );
    return false;
  }

  snapshot(): CatchupQueueSnapshot {
    // A covered entry never runs, so it must not be reported as queued either.
    this.dropCovered();
    const queued: CatchupQueueEntry[] = Array.from(this.pending.values()).map(
      (e) => ({
        jobId: e.jobId,
        jobName: this.deps.jobName(e.jobId),
        missedSlot: e.missedSlot.toISOString(),
        enqueuedAt: e.enqueuedAt.toISOString(),
      }),
    );
    const inFlight: CatchupQueueInFlight | null = this.inFlight
      ? {
          jobId: this.inFlight.jobId,
          jobName: this.deps.jobName(this.inFlight.jobId),
          startedAt: this.inFlight.startedAt.toISOString(),
        }
      : null;
    return { queued, inFlight };
  }

  /**
   * Drops every queued catch-up whose job has run since its missed slot: a scheduled tick, a
   * manual run or a catch-up that started at or after the slot, finished or still running.
   * An entry can wait a long time behind others (2026-09-29: babysit-prs' 06:00Z slot, queued
   * at 06:13Z behind five catch-ups, still ran after its own 07:00Z tick). A run that started
   * before the slot does not count: that slot was skipped for overlap and still needs its run.
   */
  private dropCovered(): void {
    const newestRunStartedAt = this.deps.newestRunStartedAt;
    if (!newestRunStartedAt) return;
    for (const [jobId, entry] of this.pending) {
      const startedAt = newestRunStartedAt(jobId);
      const startedMs = startedAt === null ? NaN : Date.parse(startedAt);
      if (!(startedMs >= entry.missedSlot.getTime())) continue;
      this.pending.delete(jobId);
      console.log(
        `[catchup] Dropped ${jobId} catch-up for missed slot ${entry.missedSlot.toISOString()}: already covered by the run started ${new Date(startedMs).toISOString()}`,
      );
    }
  }

  process(): void {
    // Before the busy checks, so any poke (a run ending, a sweep) clears covered entries.
    this.dropCovered();
    if (this.inFlight) return;
    if (this.gapTimer) return;
    if (this.networkWait) return;
    let next = this.pending.values().next().value;
    // Re-check the policy at start time: an entry can wait past midnight behind others.
    while (next && !this.policyAllowsNow(next.jobId, next.missedSlot)) {
      this.pending.delete(next.jobId);
      next = this.pending.values().next().value;
    }
    if (!next) return;

    if (this.deps.isJobActive(next.jobId)) {
      // Leave queued; caller will poke us again after the active run finishes.
      return;
    }

    // Wait for the network first, then pick again: while waiting, the head can be covered
    // by a run, pass its same-day date, or have its job start.
    const waitedRecently =
      this.networkWaitEndedAt !== null &&
      Date.now() - this.networkWaitEndedAt < NETWORK_WAIT_FRESH_MS;
    if (this.deps.waitForNetwork && !waitedRecently) {
      this.networkWait = this.deps
        .waitForNetwork()
        .then(
          () => undefined,
          (err: unknown) => {
            console.error("[catchup] Network wait failed:", err);
          },
        )
        .finally(() => {
          this.networkWait = null;
          this.networkWaitEndedAt = Date.now();
          this.process();
        });
      return;
    }
    this.networkWaitEndedAt = null;

    this.pending.delete(next.jobId);
    this.inFlight = { jobId: next.jobId, startedAt: new Date() };

    void this.deps
      .runCatchup(next.jobId, next.missedSlot)
      .catch((err: unknown) => {
        console.error(`[catchup] ${next.jobId}: run failed:`, err);
      })
      .finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
  }

  private scheduleNext(): void {
    if (this.gapTimer) return;
    if (this.pending.size === 0) return;
    if (this.gapMs <= 0) {
      this.process();
      return;
    }
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.process();
    }, this.gapMs);
  }
}
