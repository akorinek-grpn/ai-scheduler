import { CronExpressionParser } from "cron-parser";

import type { CatchupQueueSnapshot, CatchupQueueEntry, CatchupQueueInFlight } from "@shared/types";

export interface DetectMissedRunArgs {
  schedule: string;
  lastStartedAt: string | null;
  now: Date;
  isActive: boolean;
}

const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function detectMissedRun(args: DetectMissedRunArgs): Date | null {
  if (args.isActive) return null;

  let prev: Date;
  try {
    // Use now - TOLERANCE as reference so slots that fired within the tolerance
    // window are not treated as missed (e.g. job started 2 min after the slot).
    const refDate = new Date(args.now.getTime() - TOLERANCE_MS);
    const parser = CronExpressionParser.parse(args.schedule, { currentDate: refDate });
    prev = parser.prev().toDate();
  } catch {
    return null;
  }

  const nowMs = args.now.getTime();
  if (nowMs - prev.getTime() > MAX_LOOKBACK_MS) return null;

  const lastMs = args.lastStartedAt ? new Date(args.lastStartedAt).getTime() : 0;
  if (prev.getTime() <= lastMs + TOLERANCE_MS) return null;

  return prev;
}

export interface CatchupQueueDeps {
  runCatchup: (jobId: string, missedSlot: Date) => Promise<void>;
  isJobActive: (jobId: string) => boolean;
  jobName: (jobId: string) => string;
  gapMs?: number;
}

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

export class CatchupQueue {
  private pending = new Map<string, PendingEntry>();
  private inFlight: InFlightEntry | null = null;
  private gapMs: number;
  private gapTimer: NodeJS.Timeout | null = null;

  constructor(private deps: CatchupQueueDeps) {
    this.gapMs = deps.gapMs ?? DEFAULT_GAP_MS;
  }

  enqueue(jobId: string, missedSlot: Date): void {
    const existing = this.pending.get(jobId);
    this.pending.set(jobId, {
      jobId,
      missedSlot,
      enqueuedAt: existing?.enqueuedAt ?? new Date(),
    });
  }

  snapshot(): CatchupQueueSnapshot {
    const queued: CatchupQueueEntry[] = Array.from(this.pending.values()).map((e) => ({
      jobId: e.jobId,
      jobName: this.deps.jobName(e.jobId),
      missedSlot: e.missedSlot.toISOString(),
      enqueuedAt: e.enqueuedAt.toISOString(),
    }));
    const inFlight: CatchupQueueInFlight | null = this.inFlight
      ? {
          jobId: this.inFlight.jobId,
          jobName: this.deps.jobName(this.inFlight.jobId),
          startedAt: this.inFlight.startedAt.toISOString(),
        }
      : null;
    return { queued, inFlight };
  }

  process(): void {
    if (this.inFlight) return;
    if (this.gapTimer) return;
    const next = this.pending.values().next().value;
    if (!next) return;

    if (this.deps.isJobActive(next.jobId)) {
      // Leave queued; caller will poke us again after the active run finishes.
      return;
    }

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
