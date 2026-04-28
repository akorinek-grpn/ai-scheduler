# Offline Catch-up Queue — Design

**Status:** Approved 2026-04-28

## Goal

When a scheduled job misses one or more slots — because the PC was off,
the daemon crashed, or a previous run blocked the next slot — automatically
run **one** catch-up as soon as possible. Multiple missed slots for the same
job collapse to a single run. Catch-ups are paced so the scheduler never
fires more than one at a time across the whole queue.

## Motivation

Today, missed slots vanish silently. A job scheduled for 9:00 AM on Mon-Fri
that's missed on Wednesday because the laptop was closed simply does not run.
The user wants those runs to happen the next time the daemon is up — but
without replaying every individual missed slot, and without stacking N
parallel runs the moment the daemon comes back.

## Detection

A run is "missed" for a given job when:

```
prev          = cron-parser.prev(job.schedule, now)   // last expected slot ≤ now
last          = read latest/status.json startedAt     // null if the job has never run
tolerance     = 5 minutes
maxLookback   = 24 hours

is_missed = prev > now - maxLookback
        AND prev > (last ?? 0) + tolerance
        AND !engine.isJobActive(jobId)
```

Two evaluation triggers:

1. **Daemon startup.** For every enabled job, evaluate `is_missed`. If true,
   enqueue `{jobId, missedSlot: prev}`. This covers the primary case: PC was
   off, daemon was down, multiple slots missed.

2. **During uptime — overlap skip.** When cron fires for a job whose previous
   run is still active, the existing code in `CronEngine.executeJob` logs a
   warning and returns. Extend it to also enqueue
   `{jobId, missedSlot: now}` before returning.

The dedupe key is `jobId`. Re-enqueueing an already-queued job overwrites
`missedSlot` with the more recent value (so a long outage that crosses
multiple slots still resolves to a single catch-up run referencing the
most recent missed slot).

## Queue and worker

State is fully in memory; nothing is persisted to disk:

```ts
class CatchupQueue {
  private pending: Map<jobId, { missedSlot: Date, enqueuedAt: Date }>;
  private inFlight: { jobId, startedAt: Date } | null;
  private gapMs = 60_000;

  enqueue(jobId, missedSlot): void;       // dedupe by key
  snapshot(): { queued: [...], inFlight: ... };  // for /api/queue/catchups
  // Internal:
  // - process() picks one entry FIFO, runs job, waits gapMs, recurses.
  // - skip if engine.isJobActive(jobId); leave queued, revisit later.
}
```

**Why no persistence.** Detection is a pure function of
`(scheduler.yaml, data/runs/, now)`. A crash mid-catch-up just means the
next startup re-runs detection and the still-missed jobs re-enter the
queue automatically. No queue file format, no restore logic.

**Concurrency = 1.** Hardcoded. Most jobs are Claude calls; parallelism
spikes API load and competes for tokens.

**Inter-job gap = 60 seconds.** Hardcoded. After a job completes, wait
60s before starting the next queued catch-up. Promote both numbers to
`scheduler.yaml defaults` only if a real workload pressure surfaces.

## Lifecycle wiring

```
daemon startup
   └─> engine.loadJobs(config)
   └─> catchupQueue = new CatchupQueue(engine)
   └─> for each enabled job in config:
         └─> if is_missed → catchupQueue.enqueue(jobId, prev)
   └─> catchupQueue.process()    // start the worker

cron fires for jobId, but engine.isJobActive(jobId)
   └─> log "skipping" warning (existing behavior)
   └─> catchupQueue.enqueue(jobId, now)

job completes (any trigger)
   └─> catchupQueue.process()    // poke the worker

worker picks next:
   └─> if engine.isJobActive(jobId) → leave queued, return
   └─> jobConfig = engine.getCurrentConfig().jobs[jobId]
   └─> runJob({ trigger: "catchup", catchupFor: missedSlot.toISOString(), ... })
   └─> setTimeout(process, gapMs)
```

## Data model changes

```ts
// src/shared/types.ts
type TriggerType = "scheduled" | "manual" | "catchup";   // extended union

interface RunMeta {
  // existing fields unchanged
  trigger: TriggerType;
  catchupFor?: string;   // ISO of the missed slot — only set when trigger === "catchup"
}

interface RunSummary {
  // existing fields unchanged
  trigger: TriggerType;
  catchupFor?: string;
}
```

`config-schema.ts` requires no change — `JobConfig` doesn't carry trigger
type. The only schema bump is on `RunMeta` / `RunSummary`.

## API

```
GET /api/queue/catchups

Response:
{
  "queued": [
    { "jobId": "babysit-prs", "jobName": "Babysit PRs ...",
      "missedSlot": "2026-04-28T16:00:00Z",
      "enqueuedAt": "2026-04-28T16:14:02Z" }
  ],
  "inFlight": {
    "jobId": "eod-report",
    "jobName": "EOD Report — End of Day Update",
    "startedAt": "2026-04-28T16:13:30Z"
  }
}
```

Read-only. Web UI polls this on the existing dashboard cycle.

## UI

Two minimal surface changes:

1. **`<RunsTable>`.** When `run.trigger === "catchup"`, prepend a `↻` icon
   to the row with a `title` tooltip `"Catch-up for missed slot at
   <local-time>"`. Distinguishable at a glance from regular scheduled
   runs (no icon) and manual runs (existing manual badge).

2. **`<StatsCards>`.** When `inFlight !== null` or `queued.length > 0`,
   append a chip after the existing stats:
   ```
   ↻ 3 catch-ups queued · running: babysit-prs
   ```
   Hidden entirely when the queue is empty and nothing is in flight
   (zero state — no visual noise).

Both components already poll the daemon every 5s, so adding a single
`getCatchupQueue()` call to the existing fetch fan-out is sufficient.

## Tests

```
src/daemon/__tests__/catchup.test.ts
  - detectMissedRun: returns missed slot when last run is older than prev
  - detectMissedRun: returns null when last run is within tolerance of prev
  - detectMissedRun: returns null when prev is older than 24h
  - detectMissedRun: returns null when no runs exist AND prev is older than 24h
  - detectMissedRun: returns missed slot when no runs exist AND prev is recent
  - CatchupQueue.enqueue: dedupes by jobId, keeps latest missedSlot
  - CatchupQueue.process: respects gapMs between jobs (fake timers)
  - CatchupQueue.process: skips when engine reports the job active
```

The cron-engine wiring (startup detection, overlap-skip, completion poke)
is exercised through `cron-engine.test.ts` with stubbed `runJob`.

## Out of scope (deliberate)

- **Per-job opt-out** (`catchup: false` in `scheduler.yaml`) — defer
- **Configurable concurrency / gap** — hardcoded in v1
- **Catch-up "ghost" dot in timeline view** — polish; deferred
- **Persisting the queue across restarts** — detection is recomputed
- **Replaying every individual missed slot as a separate run** — the user
  explicitly excluded stacking
- **Notifications for catch-ups** — could piggyback on existing notification
  provider later

## File summary

```
CREATE src/daemon/catchup.ts                       # detectMissedRun + CatchupQueue
CREATE src/daemon/__tests__/catchup.test.ts        # unit tests
MODIFY src/daemon/cron-engine.ts                   # wire enqueue + process at the 3 lifecycle points
MODIFY src/daemon/job-runner.ts                    # accept + persist catchupFor in meta
MODIFY src/daemon/api.ts                           # GET /api/queue/catchups
MODIFY src/daemon/index.ts                         # construct CatchupQueue, run startup detection
MODIFY src/shared/types.ts                         # extend TriggerType, add catchupFor
MODIFY src/web/lib/api-client.ts                   # getCatchupQueue() + types
MODIFY src/web/components/runs-table.tsx           # ↻ catch-up badge per row
MODIFY src/web/components/stats-cards.tsx          # pending-count chip
MODIFY src/web/app/page.tsx                        # fetch + thread queue snapshot to consumers
```
