# Offline Catch-up Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect missed scheduled runs (PC was off, daemon crashed, prior run blocked the slot), enqueue a single catch-up per job, and process the queue serially with a 60s gap. Surface the queue and the catch-up trigger in the dashboard UI.

**Architecture:** Pure detection helper computes whether a job has a missed slot in the last 24h. An in-memory `CatchupQueue` (no persistence) dedupes by `jobId` and runs catch-ups one at a time via callbacks into the existing `CronEngine`. Wired at three lifecycle points: daemon startup, cron-overlap-skip, and post-run completion.

**Tech Stack:** Node.js + Express (daemon), `cron-parser` (already a dep), Vitest fake timers, Next.js + React + Tailwind (web).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | Extend `TriggerType` to include `"catchup"`; add `catchupFor` to `RunMeta` and `RunSummary`; add `CatchupQueueSnapshot` |
| `src/daemon/catchup.ts` | New. `detectMissedRun()` pure helper + `CatchupQueue` class (enqueue, snapshot, worker loop) |
| `src/daemon/__tests__/catchup.test.ts` | New. Unit tests for both |
| `src/daemon/job-runner.ts` | Accept new `catchupFor?: string` option, persist into `meta.json` |
| `src/daemon/cron-engine.ts` | Hold queue reference; `runCatchup()` method; enqueue on overlap-skip; `process()` post-run |
| `src/daemon/index.ts` | Construct `CatchupQueue`, run startup detection, kick worker |
| `src/daemon/api.ts` | `GET /api/queue/catchups` |
| `src/daemon/__tests__/api.test.ts` | New cases for the endpoint |
| `src/web/app/api/queue/catchups/route.ts` | New. Next.js proxy |
| `src/web/lib/api-client.ts` | `getCatchupQueue()` + extend `RunResponse.trigger` and `catchupFor` |
| `src/web/components/runs-table.tsx` | `↻` badge on catch-up rows |
| `src/web/components/stats-cards.tsx` | Pending-count chip |
| `src/web/app/page.tsx` | Fetch + thread queue snapshot to `<StatsCards>` |

---

## Task 1: Extend types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Extend `TriggerType` and add `catchupFor`**

In `src/shared/types.ts`, change:

```typescript
export type TriggerType = "scheduled" | "manual";
```

to:

```typescript
export type TriggerType = "scheduled" | "manual" | "catchup";
```

Find the `RunMeta` interface and add `catchupFor`:

```typescript
export interface RunMeta {
  jobId: string;
  runId: string;
  jobConfig: JobConfig;
  trigger: TriggerType;
  startedAt: string;
  catchupFor?: string;
}
```

Find the `RunSummary` interface and add `catchupFor`:

```typescript
export interface RunSummary {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: RunStatus;
  trigger: TriggerType;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
  catchupFor?: string;
}
```

At the end of the file, add:

```typescript
export interface CatchupQueueEntry {
  jobId: string;
  jobName: string;
  missedSlot: string;
  enqueuedAt: string;
}

export interface CatchupQueueInFlight {
  jobId: string;
  jobName: string;
  startedAt: string;
}

export interface CatchupQueueSnapshot {
  queued: CatchupQueueEntry[];
  inFlight: CatchupQueueInFlight | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): extend TriggerType with 'catchup' and add CatchupQueueSnapshot"
```

---

## Task 2: `detectMissedRun` pure helper

**Files:**
- Create: `src/daemon/catchup.ts`
- Create: `src/daemon/__tests__/catchup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/__tests__/catchup.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- catchup.test.ts`
Expected: FAIL — module `../catchup` does not exist.

- [ ] **Step 3: Implement `detectMissedRun`**

Create `src/daemon/catchup.ts`:

```typescript
import { CronExpressionParser } from "cron-parser";

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
    const parser = CronExpressionParser.parse(args.schedule, { currentDate: args.now });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- catchup.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/catchup.ts src/daemon/__tests__/catchup.test.ts
git commit -m "feat(daemon): add detectMissedRun pure helper for catch-up queue"
```

---

## Task 3: `runJob` accepts and persists `catchupFor`

**Files:**
- Modify: `src/daemon/job-runner.ts`
- Modify: `src/daemon/__tests__/job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/daemon/__tests__/job-runner.test.ts` (inside the existing top-level scope, after the existing `describe("runJob stats.json", ...)` block):

```typescript
describe("runJob catchupFor", () => {
  it("persists catchupFor into meta.json when provided", async () => {
    const missedSlot = "2026-04-28T09:00:00.000Z";
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "catchup",
      catchupFor: missedSlot,
      command: "echo",
      args: ["catchup"],
    });

    const metaPath = path.join(tmpDir, "data", "runs", "test-job", run.runId, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.trigger).toBe("catchup");
    expect(meta.catchupFor).toBe(missedSlot);
  });

  it("does not write catchupFor when not provided", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["plain"],
    });

    const metaPath = path.join(tmpDir, "data", "runs", "test-job", run.runId, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.catchupFor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- job-runner.test.ts`
Expected: FAIL — TypeScript error on `trigger: "catchup"` (TriggerType already accepts it from Task 1) but `catchupFor` is not on the `RunJobOptions` interface yet, so it's a compile error.

- [ ] **Step 3: Add `catchupFor` to `RunJobOptions` and propagate into meta**

In `src/daemon/job-runner.ts`, find the `RunJobOptions` interface near the top (around line 13) and add `catchupFor`:

```typescript
interface RunJobOptions {
  jobId: string;
  jobConfig: JobConfig;
  projectRoot: string;
  trigger: TriggerType;
  command?: string;
  args?: string[];
  defaultTimeout?: number;
  catchupFor?: string;
}
```

Find `runJob`'s top destructuring (around line 153) and add the field:

```typescript
export async function runJob(options: RunJobOptions): Promise<RunResult> {
  const { jobId, jobConfig, projectRoot, trigger, defaultTimeout = 300, catchupFor } = options;
```

Find the `meta` construction (around line 159) and include `catchupFor` only when set:

```typescript
const meta: RunMeta = {
  jobId,
  runId,
  jobConfig,
  trigger,
  startedAt: new Date().toISOString(),
  ...(catchupFor !== undefined ? { catchupFor } : {}),
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- job-runner.test.ts`
Expected: PASS — all existing tests + 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/job-runner.ts src/daemon/__tests__/job-runner.test.ts
git commit -m "feat(daemon): runJob accepts and persists catchupFor in meta"
```

---

## Task 4: `CatchupQueue` class

**Files:**
- Modify: `src/daemon/catchup.ts`
- Modify: `src/daemon/__tests__/catchup.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/daemon/__tests__/catchup.test.ts`:

```typescript
import { vi } from "vitest";
import { CatchupQueue } from "../catchup";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- catchup.test.ts`
Expected: FAIL — `CatchupQueue` is not exported.

- [ ] **Step 3: Implement `CatchupQueue`**

Append to `src/daemon/catchup.ts`:

```typescript
import type { CatchupQueueSnapshot, CatchupQueueEntry, CatchupQueueInFlight } from "@shared/types";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- catchup.test.ts`
Expected: PASS — 11/11 (6 detection + 5 queue).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/catchup.ts src/daemon/__tests__/catchup.test.ts
git commit -m "feat(daemon): add CatchupQueue with FIFO worker, dedupe, and gap pacing"
```

---

## Task 5: Wire `CatchupQueue` into `CronEngine`

**Files:**
- Modify: `src/daemon/cron-engine.ts`
- Modify: `src/daemon/__tests__/cron-engine.test.ts`

- [ ] **Step 1: Write the failing test**

The existing `describe("CronEngine", ...)` block already declares `tmpDir`, `configPath`, and a `makeConfig(jobs)` helper. Add this `it(...)` case at the end of that describe (inside the closing `});`):

```typescript
it("runCatchup runs a job with trigger=catchup and writes catchupFor in meta", async () => {
  const config = makeConfig({
    "catchup-test-job": {
      name: "Catch-up Test Job",
      schedule: "0 9 * * *",
      directory: os.tmpdir(),
      type: "script",
      command: "echo catchup-test",
      enabled: true,
      tags: [],
    },
  });

  const engine = new CronEngine(tmpDir);
  engine.loadJobs(config);

  const result = await engine.runCatchup(
    "catchup-test-job",
    new Date("2026-04-28T09:00:00Z"),
  );

  expect(result).toHaveProperty("runId");
  if (!("runId" in result)) throw new Error("expected runId");

  const meta = JSON.parse(
    fs.readFileSync(
      path.join(tmpDir, "data", "runs", "catchup-test-job", result.runId, "meta.json"),
      "utf-8",
    ),
  );
  expect(meta.trigger).toBe("catchup");
  expect(meta.catchupFor).toBe("2026-04-28T09:00:00.000Z");

  engine.stopAll();
});

it("returns error from runCatchup when job is unknown", async () => {
  const engine = new CronEngine(tmpDir);
  engine.loadJobs(makeConfig({}));
  const result = await engine.runCatchup("missing", new Date());
  expect(result).toEqual({ error: "Job not found: missing" });
  engine.stopAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- cron-engine.test.ts`
Expected: FAIL — `engine.runCatchup` is not a function.

- [ ] **Step 3: Update `cron-engine.ts` imports**

At the top of `src/daemon/cron-engine.ts`, add:

```typescript
import type { CatchupQueue } from "./catchup";
```

- [ ] **Step 4: Hold a queue reference and add `setCatchupQueue`**

Inside the `CronEngine` class, add a private field and setter near the other private fields (around line 8-12):

```typescript
private catchupQueue: CatchupQueue | null = null;
```

Add a method (place near `getCurrentConfig`):

```typescript
setCatchupQueue(queue: CatchupQueue): void {
  this.catchupQueue = queue;
}
```

- [ ] **Step 5: Add `runCatchup`**

Add this method to `CronEngine` (place after `triggerJob`):

```typescript
async runCatchup(
  jobId: string,
  missedSlot: Date,
): Promise<{ runId: string } | { error: string }> {
  if (!this.currentConfig) return { error: "No config loaded" };
  const jobConfig = this.currentConfig.jobs[jobId];
  if (!jobConfig) return { error: `Job not found: ${jobId}` };
  if (this.activeJobs.has(jobId)) return { error: `Job already running: ${jobId}` };

  this.activeJobs.add(jobId);
  try {
    const result = await runJob({
      jobId,
      jobConfig,
      projectRoot: this.projectRoot,
      trigger: "catchup",
      catchupFor: missedSlot.toISOString(),
      defaultTimeout: this.currentConfig.defaults.timeout,
    });
    evaluateRun(this.projectRoot, jobId, result.runId, jobConfig.name, result.status, result.exitCode)
      .catch((err) => console.error(`[eval] ${jobId}: evaluation failed:`, err));
    pruneOldRuns(this.projectRoot, jobId, this.currentConfig.defaults.retain_runs);
    return { runId: result.runId };
  } finally {
    this.activeJobs.delete(jobId);
    this.catchupQueue?.process();
  }
}
```

- [ ] **Step 6: Enqueue on overlap-skip and poke the queue after every run**

Find `executeJob` (around line 52). Replace the early-return block when `activeJobs.has(jobId)` and the `finally` block:

```typescript
if (this.activeJobs.has(jobId)) {
  console.warn(`[cron] Skipping ${jobId} — previous run still active`);
  this.catchupQueue?.enqueue(jobId, new Date());
  return;
}
```

In the same method's `finally`, after `this.activeJobs.delete(jobId);`, add:

```typescript
this.catchupQueue?.process();
```

Also in `triggerJob`'s `finally`, add the same poke:

```typescript
} finally {
  this.activeJobs.delete(jobId);
  this.catchupQueue?.process();
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- cron-engine.test.ts`
Expected: PASS — existing tests + the new one.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/cron-engine.ts src/daemon/__tests__/cron-engine.test.ts
git commit -m "feat(daemon): wire CatchupQueue into CronEngine (runCatchup, overlap enqueue, post-run poke)"
```

---

## Task 6: Startup detection in `daemon/index.ts`

**Files:**
- Modify: `src/daemon/index.ts`
- Modify: `src/shared/paths.ts` (only if needed — see Step 3)

- [ ] **Step 1: Add a helper to read the latest run's startedAt**

In `src/shared/paths.ts`, ensure `import fs from "fs";` is present near the top. (`paths.ts` currently imports only `path`; add `fs` if missing.)

After `getEvalPath`, add the helper:

```typescript
export function getLatestRunStartedAt(projectRoot: string, jobId: string): string | null {
  try {
    const runId = fs.readlinkSync(getLatestSymlink(projectRoot, jobId));
    const meta = JSON.parse(fs.readFileSync(getMetaPath(projectRoot, jobId, runId), "utf-8"));
    return typeof meta?.startedAt === "string" ? meta.startedAt : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Wire startup detection in `daemon/index.ts`**

In `src/daemon/index.ts`, add imports near the top:

```typescript
import { CatchupQueue, detectMissedRun } from "./catchup";
import { getLatestRunStartedAt } from "@shared/paths";
```

Find the `main()` function. After `engine.loadJobs(configResult.data);` (around line 110), add:

```typescript
const catchupQueue = new CatchupQueue({
  runCatchup: async (jobId, slot) => {
    await engine.runCatchup(jobId, slot);
  },
  isJobActive: (jobId) => engine.getActiveJobIds().includes(jobId),
  jobName: (jobId) => engine.getCurrentConfig()?.jobs[jobId]?.name ?? jobId,
});
engine.setCatchupQueue(catchupQueue);

const now = new Date();
let enqueuedCount = 0;
for (const [jobId, jobConfig] of Object.entries(configResult.data.jobs)) {
  if (!jobConfig.enabled) continue;
  const lastStartedAt = getLatestRunStartedAt(PROJECT_ROOT, jobId);
  const missed = detectMissedRun({
    schedule: jobConfig.schedule,
    lastStartedAt,
    now,
    isActive: engine.getActiveJobIds().includes(jobId),
  });
  if (missed) {
    catchupQueue.enqueue(jobId, missed);
    enqueuedCount += 1;
    console.log(`[catchup] Enqueued ${jobId} for missed slot ${missed.toISOString()}`);
  }
}
if (enqueuedCount > 0) {
  console.log(`[catchup] ${enqueuedCount} catch-up(s) queued from startup detection`);
  catchupQueue.process();
}
```

- [ ] **Step 3: Run tests to verify nothing regressed**

Run: `npm run test`
Expected: PASS — all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/index.ts src/shared/paths.ts
git commit -m "feat(daemon): startup detection enqueues missed runs into CatchupQueue"
```

---

## Task 7: `GET /api/queue/catchups` endpoint

**Files:**
- Modify: `src/daemon/api.ts`
- Modify: `src/daemon/__tests__/api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("daemon API", ...)` block in `src/daemon/__tests__/api.test.ts` (immediately before the outer describe's closing `});`):

```typescript
describe("GET /api/queue/catchups", () => {
  it("returns an empty snapshot when no catch-up queue is set", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/queue/catchups");
    expect(res.status).toBe(200);
    const body = res.body as { queued: unknown[]; inFlight: unknown };
    expect(body.queued).toEqual([]);
    expect(body.inFlight).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- api.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add a `getCatchupQueue` accessor to `CronEngine`**

In `src/daemon/cron-engine.ts`, add a getter near `setCatchupQueue`:

```typescript
getCatchupQueue(): CatchupQueue | null {
  return this.catchupQueue;
}
```

- [ ] **Step 4: Add the API route**

In `src/daemon/api.ts`, register the route alongside the other `app.get(...)` calls (after `/api/stats/activity`, before `return app`):

```typescript
app.get("/api/queue/catchups", (_req, res) => {
  const queue = engine.getCatchupQueue();
  if (!queue) {
    res.json({ queued: [], inFlight: null });
    return;
  }
  res.json(queue.snapshot());
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- api.test.ts`
Expected: PASS — all existing + new case.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/api.ts src/daemon/cron-engine.ts src/daemon/__tests__/api.test.ts
git commit -m "feat(daemon): add GET /api/queue/catchups endpoint"
```

---

## Task 8: Next.js proxy + client function

**Files:**
- Create: `src/web/app/api/queue/catchups/route.ts`
- Modify: `src/web/lib/api-client.ts`

- [ ] **Step 1: Create the proxy route**

Create `src/web/app/api/queue/catchups/route.ts`:

```typescript
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

function getDaemonUrl(): string | null {
  try {
    const daemonJsonPath = path.join(PROJECT_ROOT, "data", "daemon.json");
    const daemonJson = JSON.parse(fs.readFileSync(daemonJsonPath, "utf-8"));
    return `http://127.0.0.1:${daemonJson.port}`;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const url = getDaemonUrl();
  if (!url) {
    return NextResponse.json({ queued: [], inFlight: null }, { status: 503 });
  }
  try {
    const res = await fetch(`${url}/api/queue/catchups`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ queued: [], inFlight: null }, { status: 503 });
  }
}
```

- [ ] **Step 2: Add client function and extend types**

In `src/web/lib/api-client.ts`:

Find the `RunResponse` interface (around line 33) and update `trigger` plus add `catchupFor`:

```typescript
export interface RunResponse {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: "running" | "success" | "partial" | "failed" | "timeout";
  trigger: "scheduled" | "manual" | "catchup";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
  catchupFor?: string;
}
```

Append to the end of the file:

```typescript
export interface CatchupQueueEntry {
  jobId: string;
  jobName: string;
  missedSlot: string;
  enqueuedAt: string;
}

export interface CatchupQueueInFlight {
  jobId: string;
  jobName: string;
  startedAt: string;
}

export interface CatchupQueueSnapshot {
  queued: CatchupQueueEntry[];
  inFlight: CatchupQueueInFlight | null;
}

export function getCatchupQueue(): Promise<CatchupQueueSnapshot> {
  return fetchApi("/queue/catchups");
}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/app/api/queue/catchups/route.ts src/web/lib/api-client.ts
git commit -m "feat(web): proxy /api/queue/catchups and add getCatchupQueue client"
```

---

## Task 9: `↻` catch-up badge in `<RunsTable>`

**Files:**
- Modify: `src/web/components/runs-table.tsx`

- [ ] **Step 1: Add the badge in `RunRow`**

In `src/web/components/runs-table.tsx`, find the `RunRow` component's existing trigger block (around line 162):

```tsx
{/* Trigger */}
{run.trigger === "manual" && (
  <span className="text-[10px] text-muted-foreground shrink-0">manual</span>
)}
```

Replace it with:

```tsx
{/* Trigger */}
{run.trigger === "manual" && (
  <span className="text-[10px] text-muted-foreground shrink-0">manual</span>
)}
{run.trigger === "catchup" && (
  <span
    className="text-[10px] text-blue-500 shrink-0 flex items-center gap-0.5"
    title={
      run.catchupFor
        ? `Catch-up for missed slot at ${new Date(run.catchupFor).toLocaleString()}`
        : "Catch-up run"
    }
  >
    <span aria-hidden="true">↻</span> catch-up
  </span>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/runs-table.tsx
git commit -m "feat(web): show catch-up badge in RunsTable"
```

---

## Task 10: Pending-count chip in `<StatsCards>`

**Files:**
- Modify: `src/web/components/stats-cards.tsx`

- [ ] **Step 1: Accept the queue snapshot prop**

In `src/web/components/stats-cards.tsx`, update imports and the `StatsCardsProps` interface:

```typescript
import type {
  RunResponse,
  JobResponse,
  HealthResponse,
  CatchupQueueSnapshot,
} from "@/lib/api-client";

interface StatsCardsProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  health: HealthResponse | null;
  catchups?: CatchupQueueSnapshot | null;
}
```

Update the function signature:

```typescript
export function StatsCards({ jobs, runs, health, catchups }: StatsCardsProps): React.ReactElement {
```

- [ ] **Step 2: Render the chip**

Inside the JSX, after the existing follow-up block (around the `{followUpCount > 0 && (...)}` section), add:

```tsx
{catchups && (catchups.queued.length > 0 || catchups.inFlight) && (
  <>
    <span className="text-border">|</span>
    <div className="flex items-baseline gap-1.5" aria-label="Catch-up queue">
      <span className="text-[13px] font-mono font-semibold text-blue-500 tabular-nums">
        {catchups.queued.length}
      </span>
      <span className="text-[12px] text-blue-500/80">
        ↻ catch-ups queued
      </span>
      {catchups.inFlight && (
        <span className="text-[11px] text-blue-500/70 ml-1">
          · running: {catchups.inFlight.jobName}
        </span>
      )}
    </div>
  </>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/components/stats-cards.tsx
git commit -m "feat(web): show pending catch-up chip in StatsCards"
```

---

## Task 11: Fetch and thread the snapshot from the dashboard page

**Files:**
- Modify: `src/web/app/page.tsx`

- [ ] **Step 1: Fetch the queue alongside the existing data**

In `src/web/app/page.tsx`, update imports:

```typescript
import {
  getHealth,
  getJobs,
  getRuns,
  getCatchupQueue,
  type HealthResponse,
  type JobResponse,
  type RunResponse,
  type CatchupQueueSnapshot,
} from "@/lib/api-client";
```

Add state:

```typescript
const [catchups, setCatchups] = useState<CatchupQueueSnapshot | null>(null);
```

Update the `fetchAll` callback to include the catchup queue (around line 55):

```typescript
const fetchAll = useCallback(async () => {
  try {
    const [h, j, r, c] = await Promise.all([
      getHealth().catch(() => null),
      getJobs().catch(() => []),
      getRuns({ limit: 200 }).catch(() => []),
      getCatchupQueue().catch(() => null),
    ]);
    setHealth(h);
    setJobs(j);
    setRuns(r);
    setCatchups(c);
  } catch {
    // silently fail
  }
}, []);
```

- [ ] **Step 2: Pass the snapshot to `<StatsCards>`**

Change:

```tsx
<StatsCards jobs={jobs} runs={runs} health={health} />
```

to:

```tsx
<StatsCards jobs={jobs} runs={runs} health={health} catchups={catchups} />
```

- [ ] **Step 3: Commit**

```bash
git add src/web/app/page.tsx
git commit -m "feat(web): thread catch-up queue snapshot to StatsCards"
```

---

## Task 12: Full suite + build verification

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 2: Type-check + build**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: If anything was tripped up by types, fix and commit**

If the build surfaces a TS error (e.g., `RunResponse.trigger` consumers that don't yet accept `"catchup"`), fix the offending consumer and:

```bash
git add -A
git commit -m "chore: align consumers with extended TriggerType"
```

Skip if nothing changed.
