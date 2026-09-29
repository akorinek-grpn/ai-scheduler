import { getNewestRunStartedAt } from "@shared/paths";
import { CatchupQueue, sweepMissedRuns, startGapWatcher } from "./catchup";
import type { CronEngine } from "./cron-engine";

/** How often the missed-tick check looks for slots node-cron dropped. */
export const MISSED_TICK_POLL_MS = 30_000;

export interface CatchupWiringOptions {
  projectRoot: string;
  /** Missed-tick check interval. Default MISSED_TICK_POLL_MS. */
  missedTickPollMs?: number;
  /** Awaited before each catch-up (the queue's waitForNetwork). index.ts passes the network gate. */
  waitForNetwork?: () => Promise<unknown>;
}

export interface CatchupWiring {
  queue: CatchupQueue;
  /** Stops the gap watcher and the missed-tick check (daemon shutdown). */
  stop: () => void;
}

/**
 * Everything the daemon runs to catch up missed slots, wired to `engine`: the catch-up
 * queue (with each job's `catchup` policy), a sweep now (startup), one after every clock
 * gap, and the missed-tick check every missedTickPollMs. index.ts calls it once, after the
 * first loadJobs; tests call it the same way.
 */
export function startCatchup(
  engine: CronEngine,
  opts: CatchupWiringOptions,
): CatchupWiring {
  const isActive = (jobId: string) => engine.getActiveJobIds().includes(jobId);
  const queue = new CatchupQueue({
    runCatchup: async (jobId, slot) => {
      await engine.runCatchup(jobId, slot);
    },
    isJobActive: isActive,
    jobName: (jobId) => engine.getCurrentConfig()?.jobs[jobId]?.name ?? jobId,
    catchupPolicy: (jobId) => engine.getCurrentConfig()?.jobs[jobId]?.catchup,
    // The sweeps' source too: a queued catch-up is dropped once the job has run past its slot.
    newestRunStartedAt: (jobId) =>
      getNewestRunStartedAt(opts.projectRoot, jobId),
    waitForNetwork: opts.waitForNetwork,
  });
  engine.setCatchupQueue(queue);

  const sweep = (
    now: Date,
    source: string,
    notBefore?: (jobId: string) => Date | null,
  ): void => {
    const cfg = engine.getCurrentConfig();
    if (!cfg) return;
    const enqueued = sweepMissedRuns(
      {
        jobs: cfg.jobs,
        now,
        // Not the `latest` symlink: it moves only when a run completes, so after a restart
        // a slot whose run is still going (detached, it outlives the daemon) looked missed.
        lastStartedAt: (jobId) =>
          getNewestRunStartedAt(opts.projectRoot, jobId),
        isActive,
        notBefore,
      },
      queue,
    );
    for (const e of enqueued) {
      console.log(
        `[catchup] Enqueued ${e.jobId} for missed slot ${e.missedSlot.toISOString()}`,
      );
    }
    if (enqueued.length > 0) {
      console.log(
        `[catchup] ${enqueued.length} catch-up(s) queued from ${source}`,
      );
      queue.process();
    }
  };

  // Missed-slot detection runs at startup and again after any clock gap: a sleeping
  // laptop fires no cron ticks and node-cron never replays them, so without the
  // watcher a job stays silent until the next cron edge after wake (2026-09-25).
  sweep(new Date(), "startup detection");
  const gapWatcher = startGapWatcher({
    onGap: (gapMs, now) => {
      console.log(
        `[catchup] Clock gap of ${Math.round(gapMs / 60_000)} min (sleep?) - checking for missed slots`,
      );
      sweep(now, "wake detection");
    },
  });
  // Ticks dropped while awake (2026-09-28): node-cron 4 skips a slot whose timer fires 1 s
  // or more late (blocked event loop, delayed timer), and for the first tick after a task
  // is (re)scheduled it does not even emit 'execution:missed' - whose date is the NEXT
  // match anyway. So poll: any slot of a job's current cron task that has not run becomes
  // a catch-up within missedTickPollMs, through the same queue, policy and dedupe.
  const missedTickWatcher = setInterval(
    () =>
      sweep(new Date(), "missed-tick check", (jobId) =>
        engine.getScheduledSince(jobId),
      ),
    opts.missedTickPollMs ?? MISSED_TICK_POLL_MS,
  );
  missedTickWatcher.unref?.();

  return {
    queue,
    stop: () => {
      clearInterval(gapWatcher);
      clearInterval(missedTickWatcher);
    },
  };
}
