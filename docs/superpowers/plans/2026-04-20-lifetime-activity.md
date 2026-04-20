# Lifetime Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Lifetime Activity" dashboard section that shows total AI sessions, total tool calls, a 30-day time-series chart, and a top-tools breakdown.

**Architecture:** Extend `job-runner` to capture `tool_use` events from the Claude stream-json output and write a per-run `stats.json`. Add a new daemon endpoint `/api/stats/activity` that aggregates across all runs (backfilling legacy runs by parsing `output.log`). Render the data via a new `<LifetimeActivity>` component on the main dashboard page.

**Tech Stack:** Node.js + Express (daemon), Vitest (tests), Next.js 16 + React 19 + recharts + Tailwind (web).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | Add `RunStats` and `ActivityStatsResponse` types |
| `src/shared/paths.ts` | Add `getStatsPath(projectRoot, jobId, runId)` |
| `src/daemon/job-runner.ts` | Count `tool_use` events during run, write `stats.json` on close |
| `src/daemon/stats.ts` | Read/backfill per-run stats, aggregate across all runs |
| `src/daemon/api.ts` | Mount `GET /api/stats/activity?days=N` |
| `src/daemon/__tests__/stats.test.ts` | Unit tests for backfill + aggregation |
| `src/daemon/__tests__/job-runner.test.ts` | Extend with `stats.json` assertions |
| `src/web/app/api/stats/activity/route.ts` | Next.js proxy to daemon endpoint |
| `src/web/lib/api-client.ts` | `getActivityStats(days)` client function |
| `src/web/components/lifetime-activity.tsx` | Totals + time-series + top-tools UI |
| `src/web/app/page.tsx` | Mount `<LifetimeActivity />` on dashboard |

---

## Task 1: Add `RunStats` type

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the `RunStats` interface**

Append after the existing `RunEvaluation` interface (around line 63):

```typescript
export interface RunStats {
  toolCalls: number;
  toolsByName: Record<string, number>;
  isAiSession: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add RunStats type for per-run tool-use counts"
```

---

## Task 2: Add `getStatsPath` helper

**Files:**
- Modify: `src/shared/paths.ts`
- Modify: `src/shared/__tests__/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/shared/__tests__/paths.test.ts`:

```typescript
import { getStatsPath } from "../paths";

it("getStatsPath returns data/runs/<job>/<run>/stats.json", () => {
  expect(getStatsPath("/root", "j1", "r1")).toBe("/root/data/runs/j1/r1/stats.json");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- paths.test.ts`
Expected: FAIL — `getStatsPath is not a function` (or import error).

- [ ] **Step 3: Implement `getStatsPath`**

Append to `src/shared/paths.ts`:

```typescript
export function getStatsPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "stats.json");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/paths.ts src/shared/__tests__/paths.test.ts
git commit -m "feat(shared): add getStatsPath helper"
```

---

## Task 3: Capture `tool_use` events in job-runner

**Files:**
- Modify: `src/daemon/job-runner.ts`
- Modify: `src/daemon/__tests__/job-runner.test.ts`

**Design note:** stdout routing stays on the existing `isCustomCommand` flag (so `echo`-style test overrides keep their raw-pipe behavior). Tool-use counting is added as a pure exported helper so it can be unit-tested without spawning real processes. The runner calls the helper when it is already parsing stream-json, and always writes a `stats.json` at the end — zeros for scripts and test overrides, real counts for Claude runs.

- [ ] **Step 1: Write the failing test for the pure counting helper**

Update the imports at the top of `src/daemon/__tests__/job-runner.test.ts`:

```typescript
import { runJob, countToolUseInStreamEvent } from "../job-runner";
import { getStatsPath } from "@shared/paths";
```

Then append these `describe` blocks after the existing `describe("runJob", ...)` block:

```typescript
describe("countToolUseInStreamEvent", () => {
  it("returns tool_use names from an assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Read", input: { file_path: "/x" } },
        ],
      },
    });
    expect(countToolUseInStreamEvent(line)).toEqual(["Bash", "Read"]);
  });

  it("returns an empty array for non-assistant events", () => {
    expect(countToolUseInStreamEvent(JSON.stringify({ type: "result", result: "" }))).toEqual([]);
    expect(countToolUseInStreamEvent(JSON.stringify({ type: "user", message: {} }))).toEqual([]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(countToolUseInStreamEvent("not json")).toEqual([]);
    expect(countToolUseInStreamEvent("")).toEqual([]);
  });
});

describe("runJob stats.json", () => {
  // Reuses tmpDir + testJob from the outer describe via closure.
  it("writes stats.json with zero counts for test command overrides", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const statsPath = getStatsPath(tmpDir, "test-job", run.runId);
    expect(fs.existsSync(statsPath)).toBe(true);

    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolsByName).toEqual({});
    // testJob has no `type` set → defaults to claude semantics for stats.
    expect(stats.isAiSession).toBe(true);
  });

  it("writes stats.json with isAiSession=false for script jobs", async () => {
    const scriptJob: JobConfig = { ...testJob, type: "script", command: "echo hi" };
    const run = await runJob({
      jobId: "script-job",
      jobConfig: scriptJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const stats = JSON.parse(fs.readFileSync(getStatsPath(tmpDir, "script-job", run.runId), "utf-8"));
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolsByName).toEqual({});
    expect(stats.isAiSession).toBe(false);
  });
});
```

Note: `describe("runJob", ...)` already declares `tmpDir` and `testJob` at its top. The two new `describe` blocks must live at the top level of the file (not nested inside the existing `describe("runJob", ...)` — vitest allows them as siblings). To reuse `tmpDir` and `testJob`, move both of those declarations (and the `beforeEach`/`afterEach` that manages `tmpDir`) up to the top level of the file so the new `describe("runJob stats.json", ...)` block inherits them. If the file already has a top-level `beforeEach`/`afterEach`, leave it alone.

Concretely: lift the following lines from inside `describe("runJob", ...)` to module scope, above the describes:

```typescript
let tmpDir: string;

const testJob: JobConfig = {
  name: "Test Job",
  schedule: "0 9 * * *",
  directory: os.tmpdir(),
  prompt: "echo hello",
  enabled: true,
  tags: [],
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-runner-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

Then delete the now-duplicate declarations inside `describe("runJob", ...)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- job-runner.test.ts`
Expected: FAIL — `countToolUseInStreamEvent` is not exported from `../job-runner`; `stats.json` does not exist for the runJob cases.

- [ ] **Step 3: Update imports in `src/daemon/job-runner.ts`**

Replace the import block at the top of the file:

```typescript
import { spawn } from "child_process";
import fs from "fs";
import crypto from "crypto";
import type { JobConfig, TriggerType, RunMeta, RunStatus, RunStatusFile, RunStats } from "@shared/types";
import {
  getRunDir,
  getLogPath,
  getStatusPath,
  getMetaPath,
  getStatsPath,
  getLatestSymlink,
} from "@shared/paths";
```

- [ ] **Step 4: Export the pure counting helper**

Add this export near the top of `src/daemon/job-runner.ts`, just above `function extractTextFromStreamJson`:

```typescript
export function countToolUseInStreamEvent(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const event = JSON.parse(trimmed);
    if (event?.type !== "assistant") return [];
    const content = event.message?.content;
    if (!Array.isArray(content)) return [];
    const names: string[] = [];
    for (const block of content) {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        names.push(block.name);
      }
    }
    return names;
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Count tool uses inside the existing stream-json branch**

Inside `runJob`, locate the stream-json parsing branch (the `else` of `if (isCustomCommand)` — currently around line 198). Declare counters just before the `return new Promise(...)` call (not inside it):

```typescript
const toolsByName: Record<string, number> = {};
let toolCalls = 0;
```

Then inside the `else` branch's `for (const line of lines)` loop, add (before or after `extractTextFromStreamJson` — order does not matter):

```typescript
for (const name of countToolUseInStreamEvent(trimmed)) {
  toolCalls += 1;
  toolsByName[name] = (toolsByName[name] ?? 0) + 1;
}
```

Note that the existing code does `if (!trimmed) continue;` already, so `trimmed` is non-empty when we reach this call.

- [ ] **Step 6: Write `stats.json` in both the `close` and `error` handlers**

Just before `return new Promise(...)`, add a helper:

```typescript
const isAiSession = jobConfig.type !== "script";

const writeStats = (): void => {
  const stats: RunStats = { toolCalls, toolsByName, isAiSession };
  fs.writeFileSync(
    getStatsPath(projectRoot, jobId, runId),
    JSON.stringify(stats, null, 2),
  );
};
```

Then inside `child.on("close", ...)`, call `writeStats();` immediately after `fs.writeFileSync(getStatusPath(...), ...)` and before the symlink update. Inside `child.on("error", ...)`, call `writeStats();` at the same relative position (after writing the failed status, before the symlink update).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test -- job-runner.test.ts`
Expected: PASS for all old and new tests. The "zero counts for test command overrides" test passes because the `isCustomCommand` raw-pipe branch never runs the counting code, leaving `toolCalls` at 0.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/job-runner.ts src/daemon/__tests__/job-runner.test.ts
git commit -m "feat(daemon): capture tool_use counts per run into stats.json"
```

---

## Task 4: Backfill helper — parse `output.log`

**Files:**
- Create: `src/daemon/stats.ts`
- Create: `src/daemon/__tests__/stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/__tests__/stats.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getOrBackfillRunStats } from "../stats";
import { getStatsPath, getLogPath, getMetaPath, getRunDir } from "@shared/paths";
import type { RunMeta } from "@shared/types";

describe("getOrBackfillRunStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-stats-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeLegacyRun = (jobId: string, runId: string, logContent: string, type: "claude" | "script"): void => {
    const runDir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(getLogPath(tmpDir, jobId, runId), logContent);

    const meta: RunMeta = {
      jobId,
      runId,
      trigger: "scheduled",
      startedAt: new Date().toISOString(),
      jobConfig: {
        name: jobId,
        schedule: "* * * * *",
        directory: "/tmp",
        type,
        enabled: true,
        tags: [],
      },
    };
    fs.writeFileSync(getMetaPath(tmpDir, jobId, runId), JSON.stringify(meta));
  };

  it("returns existing stats.json without touching the log", () => {
    writeLegacyRun("j", "r1", "irrelevant", "claude");
    const prewritten = { toolCalls: 99, toolsByName: { Custom: 99 }, isAiSession: true };
    fs.writeFileSync(getStatsPath(tmpDir, "j", "r1"), JSON.stringify(prewritten));

    const stats = getOrBackfillRunStats(tmpDir, "j", "r1");
    expect(stats).toEqual(prewritten);
  });

  it("backfills tool counts from output.log markers for AI sessions", () => {
    const log = [
      "",
      "> [Bash] $ ls",
      "output line",
      "> [Read] Reading /tmp/x",
      "> [Bash] $ pwd",
      "",
    ].join("\n");
    writeLegacyRun("j", "r2", log, "claude");

    const stats = getOrBackfillRunStats(tmpDir, "j", "r2");
    expect(stats).toEqual({
      toolCalls: 3,
      toolsByName: { Bash: 2, Read: 1 },
      isAiSession: true,
    });

    // Persists the backfilled file.
    const persisted = JSON.parse(fs.readFileSync(getStatsPath(tmpDir, "j", "r2"), "utf-8"));
    expect(persisted).toEqual(stats);
  });

  it("returns zeros for script jobs without parsing", () => {
    writeLegacyRun("j", "r3", "> [something] from shell output\n", "script");

    const stats = getOrBackfillRunStats(tmpDir, "j", "r3");
    expect(stats).toEqual({
      toolCalls: 0,
      toolsByName: {},
      isAiSession: false,
    });
  });

  it("returns null when meta.json is missing", () => {
    const stats = getOrBackfillRunStats(tmpDir, "j", "missing");
    expect(stats).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- stats.test.ts`
Expected: FAIL — module `../stats` does not exist.

- [ ] **Step 3: Implement `src/daemon/stats.ts` (backfill only — aggregation in Task 5)**

```typescript
import fs from "fs";
import type { RunStats, RunMeta } from "@shared/types";
import { getStatsPath, getLogPath, getMetaPath } from "@shared/paths";

const TOOL_MARKER = /^> \[([^\]]+)\]/;

function backfillFromLog(logPath: string): { toolCalls: number; toolsByName: Record<string, number> } {
  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;

  if (!fs.existsSync(logPath)) return { toolCalls, toolsByName };

  const content = fs.readFileSync(logPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(TOOL_MARKER);
    if (!match) continue;
    const name = match[1];
    toolCalls += 1;
    toolsByName[name] = (toolsByName[name] ?? 0) + 1;
  }

  return { toolCalls, toolsByName };
}

export function getOrBackfillRunStats(
  projectRoot: string,
  jobId: string,
  runId: string,
): RunStats | null {
  const statsPath = getStatsPath(projectRoot, jobId, runId);
  if (fs.existsSync(statsPath)) {
    try {
      return JSON.parse(fs.readFileSync(statsPath, "utf-8")) as RunStats;
    } catch {
      // Corrupt — fall through to backfill.
    }
  }

  const metaPath = getMetaPath(projectRoot, jobId, runId);
  if (!fs.existsSync(metaPath)) return null;

  let meta: RunMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta;
  } catch {
    return null;
  }

  const type = meta.jobConfig?.type ?? "claude";
  const isAiSession = type === "claude";

  const counts = isAiSession
    ? backfillFromLog(getLogPath(projectRoot, jobId, runId))
    : { toolCalls: 0, toolsByName: {} };

  const stats: RunStats = { ...counts, isAiSession };

  try {
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  } catch {
    // Non-fatal — return stats even if we couldn't persist.
  }

  return stats;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- stats.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/stats.ts src/daemon/__tests__/stats.test.ts
git commit -m "feat(daemon): backfill per-run stats from output.log markers"
```

---

## Task 5: Aggregation helper

**Files:**
- Modify: `src/daemon/stats.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/daemon/__tests__/stats.test.ts`

- [ ] **Step 1: Add response type**

Append to `src/shared/types.ts`:

```typescript
export interface ActivityDayBucket {
  date: string; // YYYY-MM-DD
  sessions: number;
  toolCalls: number;
}

export interface ActivityStatsResponse {
  lifetime: {
    sessions: number;
    toolCalls: number;
    toolsByName: Record<string, number>;
  };
  daily: ActivityDayBucket[];
}
```

- [ ] **Step 2: Write the failing test**

Append to `src/daemon/__tests__/stats.test.ts`:

```typescript
import { getActivityStats } from "../stats";
import { getStatusPath } from "@shared/paths";
import type { RunStatusFile } from "@shared/types";

describe("getActivityStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-agg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const seedRun = (jobId: string, runId: string, startedAt: string, type: "claude" | "script", stats?: Partial<RunStats>): void => {
    const runDir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = {
      jobId, runId, trigger: "scheduled", startedAt,
      jobConfig: { name: jobId, schedule: "* * * * *", directory: "/tmp", type, enabled: true, tags: [] },
    };
    fs.writeFileSync(getMetaPath(tmpDir, jobId, runId), JSON.stringify(meta));
    const status: RunStatusFile = { status: "success", exitCode: 0, startedAt, finishedAt: startedAt };
    fs.writeFileSync(getStatusPath(tmpDir, jobId, runId), JSON.stringify(status));
    fs.writeFileSync(getLogPath(tmpDir, jobId, runId), "");
    if (stats) {
      fs.writeFileSync(getStatsPath(tmpDir, jobId, runId), JSON.stringify({
        toolCalls: 0, toolsByName: {}, isAiSession: type === "claude", ...stats,
      }));
    }
  };

  it("aggregates AI sessions only, ignoring script runs", () => {
    seedRun("ai", "r1", "2026-04-18T10:00:00Z", "claude", { toolCalls: 5, toolsByName: { Bash: 3, Read: 2 }, isAiSession: true });
    seedRun("ai", "r2", "2026-04-19T09:00:00Z", "claude", { toolCalls: 2, toolsByName: { Edit: 2 }, isAiSession: true });
    seedRun("sh", "r3", "2026-04-19T09:00:00Z", "script", { toolCalls: 0, toolsByName: {}, isAiSession: false });

    const result = getActivityStats(tmpDir, 30);
    expect(result.lifetime.sessions).toBe(2);
    expect(result.lifetime.toolCalls).toBe(7);
    expect(result.lifetime.toolsByName).toEqual({ Bash: 3, Read: 2, Edit: 2 });
  });

  it("bucketizes daily counts for the requested window", () => {
    const today = new Date();
    const dayStr = (d: Date): string => d.toISOString().slice(0, 10);

    const d0 = new Date(today); d0.setHours(12, 0, 0, 0);
    const d1 = new Date(today); d1.setDate(d1.getDate() - 1); d1.setHours(12, 0, 0, 0);
    const d5 = new Date(today); d5.setDate(d5.getDate() - 5); d5.setHours(12, 0, 0, 0);
    const d100 = new Date(today); d100.setDate(d100.getDate() - 100); d100.setHours(12, 0, 0, 0);

    seedRun("ai", "a", d0.toISOString(), "claude", { toolCalls: 1, toolsByName: { Bash: 1 }, isAiSession: true });
    seedRun("ai", "b", d1.toISOString(), "claude", { toolCalls: 2, toolsByName: { Bash: 2 }, isAiSession: true });
    seedRun("ai", "c", d5.toISOString(), "claude", { toolCalls: 4, toolsByName: { Read: 4 }, isAiSession: true });
    seedRun("ai", "d", d100.toISOString(), "claude", { toolCalls: 9, toolsByName: { Read: 9 }, isAiSession: true });

    const result = getActivityStats(tmpDir, 30);

    expect(result.daily.length).toBe(30);
    const today0 = result.daily.find((b) => b.date === dayStr(d0));
    expect(today0).toEqual({ date: dayStr(d0), sessions: 1, toolCalls: 1 });
    const yest = result.daily.find((b) => b.date === dayStr(d1));
    expect(yest).toEqual({ date: dayStr(d1), sessions: 1, toolCalls: 2 });

    // Run from 100 days ago must NOT appear in daily, but DOES count in lifetime.
    expect(result.lifetime.sessions).toBe(4);
    expect(result.lifetime.toolCalls).toBe(16);
  });

  it("returns empty buckets when no runs exist", () => {
    const result = getActivityStats(tmpDir, 7);
    expect(result.lifetime.sessions).toBe(0);
    expect(result.lifetime.toolCalls).toBe(0);
    expect(result.daily.length).toBe(7);
    expect(result.daily.every((b) => b.sessions === 0 && b.toolCalls === 0)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -- stats.test.ts`
Expected: FAIL — `getActivityStats` is not exported.

- [ ] **Step 4: Implement `getActivityStats`**

Append to `src/daemon/stats.ts`:

```typescript
import path from "path";
import { getRunsDir } from "@shared/paths";
import type { ActivityDayBucket, ActivityStatsResponse } from "@shared/types";

function buildEmptyDailyBuckets(days: number): ActivityDayBucket[] {
  const buckets: ActivityDayBucket[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({ date: d.toISOString().slice(0, 10), sessions: 0, toolCalls: 0 });
  }
  return buckets;
}

export function getActivityStats(projectRoot: string, days: number): ActivityStatsResponse {
  const runsDir = getRunsDir(projectRoot);
  const daily = buildEmptyDailyBuckets(days);
  const bucketIndex = new Map(daily.map((b) => [b.date, b]));

  const lifetime = {
    sessions: 0,
    toolCalls: 0,
    toolsByName: {} as Record<string, number>,
  };

  if (!fs.existsSync(runsDir)) {
    return { lifetime, daily };
  }

  for (const jobId of fs.readdirSync(runsDir)) {
    const jobDir = path.join(runsDir, jobId);
    if (!fs.statSync(jobDir).isDirectory()) continue;

    for (const runId of fs.readdirSync(jobDir)) {
      if (runId === "latest") continue;
      const runPath = path.join(jobDir, runId);
      if (!fs.statSync(runPath).isDirectory()) continue;

      const metaPath = getMetaPath(projectRoot, jobId, runId);
      if (!fs.existsSync(metaPath)) continue;

      let meta: RunMeta;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as RunMeta;
      } catch {
        continue;
      }

      const stats = getOrBackfillRunStats(projectRoot, jobId, runId);
      if (!stats || !stats.isAiSession) continue;

      lifetime.sessions += 1;
      lifetime.toolCalls += stats.toolCalls;
      for (const [name, count] of Object.entries(stats.toolsByName)) {
        lifetime.toolsByName[name] = (lifetime.toolsByName[name] ?? 0) + count;
      }

      const dateKey = new Date(meta.startedAt).toISOString().slice(0, 10);
      const bucket = bucketIndex.get(dateKey);
      if (bucket) {
        bucket.sessions += 1;
        bucket.toolCalls += stats.toolCalls;
      }
    }
  }

  return { lifetime, daily };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- stats.test.ts`
Expected: PASS (all seven cases).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/stats.ts src/shared/types.ts src/daemon/__tests__/stats.test.ts
git commit -m "feat(daemon): aggregate activity stats across runs with daily buckets"
```

---

## Task 6: Expose `GET /api/stats/activity`

**Files:**
- Modify: `src/daemon/api.ts`
- Modify: `src/daemon/__tests__/api.test.ts`

- [ ] **Step 1: Write the failing test**

The file already defines a `request(app, method, url)` helper and a `beforeEach` that creates `tmpDir` + `engine`. Use them. Append a new `describe` block at the end of `src/daemon/__tests__/api.test.ts`, keeping the outer `describe("daemon API", () => { ... })` closing brace outside:

```typescript
describe("GET /api/stats/activity", () => {
  it("returns lifetime + daily stats with default 30-day window", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/stats/activity");

    expect(res.status).toBe(200);
    const body = res.body as { lifetime: { sessions: number; toolCalls: number; toolsByName: Record<string, number> }; daily: Array<{ date: string; sessions: number; toolCalls: number }> };
    expect(body.lifetime).toBeDefined();
    expect(body.lifetime.sessions).toBe(0);
    expect(Array.isArray(body.daily)).toBe(true);
    expect(body.daily.length).toBe(30);
  });

  it("respects ?days= query param (clamped to 1..90)", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());

    const seven = await request(app, "GET", "/api/stats/activity?days=7");
    expect((seven.body as { daily: unknown[] }).daily.length).toBe(7);

    const tooMany = await request(app, "GET", "/api/stats/activity?days=500");
    expect((tooMany.body as { daily: unknown[] }).daily.length).toBe(90);

    const zero = await request(app, "GET", "/api/stats/activity?days=0");
    expect((zero.body as { daily: unknown[] }).daily.length).toBe(1);
  });
});
```

This block lives inside the existing top-level `describe("daemon API", ...)` block so it picks up `tmpDir` and `engine`. Place it immediately before the final closing `});` of the outer describe.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- api.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Mount the route in `src/daemon/api.ts`**

Add imports at the top:

```typescript
import { getActivityStats } from "./stats";
```

Register the route alongside the other `app.get(...)` calls (e.g. after the existing `/api/runs/:jobId/:runId/log` route, before the `return app` at the bottom):

```typescript
app.get("/api/stats/activity", (req, res) => {
  const raw = parseInt(req.query.days as string, 10);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, raw)) : 30;
  const stats = getActivityStats(projectRoot, days);
  res.json(stats);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- api.test.ts`
Expected: PASS for new cases; existing api tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api.ts src/daemon/__tests__/api.test.ts
git commit -m "feat(daemon): add GET /api/stats/activity endpoint"
```

---

## Task 7: Next.js proxy route

**Files:**
- Create: `src/web/app/api/stats/activity/route.ts`

- [ ] **Step 1: Create the proxy route**

Create `src/web/app/api/stats/activity/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = getDaemonUrl();
  if (!url) {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
  const days = req.nextUrl.searchParams.get("days") ?? "30";
  try {
    const res = await fetch(`${url}/api/stats/activity?days=${encodeURIComponent(days)}`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/app/api/stats/activity/route.ts
git commit -m "feat(web): proxy /api/stats/activity to the daemon"
```

---

## Task 8: Client function

**Files:**
- Modify: `src/web/lib/api-client.ts`

- [ ] **Step 1: Add types and function**

Append to `src/web/lib/api-client.ts`:

```typescript
export interface ActivityDayBucket {
  date: string;
  sessions: number;
  toolCalls: number;
}

export interface ActivityStatsResponse {
  lifetime: {
    sessions: number;
    toolCalls: number;
    toolsByName: Record<string, number>;
  };
  daily: ActivityDayBucket[];
}

export function getActivityStats(days = 30): Promise<ActivityStatsResponse> {
  return fetchApi(`/stats/activity?days=${days}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/lib/api-client.ts
git commit -m "feat(web): add getActivityStats client function"
```

---

## Task 9: `<LifetimeActivity>` component

**Files:**
- Create: `src/web/components/lifetime-activity.tsx`

- [ ] **Step 1: Create the component**

Create `src/web/components/lifetime-activity.tsx`:

```typescript
"use client";

import { useEffect, useState, useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { getActivityStats, type ActivityStatsResponse } from "@/lib/api-client";

const CHART_HEIGHT = 160;
const TOP_TOOL_COUNT = 5;

function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function topTools(toolsByName: Record<string, number>, totalCalls: number): Array<{ name: string; count: number; pct: number }> {
  const entries = Object.entries(toolsByName)
    .map(([name, count]) => ({ name, count, pct: totalCalls ? (count / totalCalls) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_TOOL_COUNT);
  return entries;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function LifetimeActivity(): React.ReactElement {
  const [data, setData] = useState<ActivityStatsResponse | null>(null);

  useEffect(() => {
    const load = (): void => {
      getActivityStats(30).then(setData).catch(() => {/* noop */});
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, []);

  const { sessions, toolCalls, avg, chartData, tools } = useMemo(() => {
    if (!data) {
      return { sessions: 0, toolCalls: 0, avg: 0, chartData: [], tools: [] as Array<{ name: string; count: number; pct: number }> };
    }
    const sessions = data.lifetime.sessions;
    const toolCalls = data.lifetime.toolCalls;
    const avg = sessions === 0 ? 0 : Math.round(toolCalls / sessions);
    const chartData = data.daily.map((d) => ({
      label: formatDate(d.date),
      sessions: d.sessions,
      toolCalls: d.toolCalls,
    }));
    return { sessions, toolCalls, avg, chartData, tools: topTools(data.lifetime.toolsByName, toolCalls) };
  }, [data]);

  return (
    <section className="rounded border border-border p-4 space-y-4" aria-label="Lifetime activity">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Lifetime Activity
        </h3>
        <span className="text-[11px] text-muted-foreground">Last 30 days trend · totals since start</span>
      </div>

      {/* Totals */}
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(sessions)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">AI sessions</div>
        </div>
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(toolCalls)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Tool calls</div>
        </div>
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(avg)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Avg tools / session</div>
        </div>
      </div>

      {/* Time-series */}
      {chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeOpacity={0.3} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              interval={Math.floor(chartData.length / 8)}
            />
            <YAxis
              yAxisId="sessions"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              width={24}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="tools"
              orientation="right"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              width={32}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                color: "var(--color-foreground)",
              }}
              cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }}
            />
            <Bar yAxisId="sessions" dataKey="sessions" fill="oklch(0.70 0.15 250)" radius={[2, 2, 0, 0]} />
            <Line
              yAxisId="tools"
              type="monotone"
              dataKey="toolCalls"
              stroke="oklch(0.70 0.18 150)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Top tools */}
      {tools.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Top tools</div>
          <div className="flex items-center gap-1 text-[11px]">
            {tools.map((t, i) => (
              <div
                key={t.name}
                className="flex items-center gap-1 px-2 py-1 rounded bg-secondary/40"
                title={`${t.name}: ${formatNumber(t.count)} calls (${t.pct.toFixed(1)}%)`}
              >
                <span className="font-medium">{t.name}</span>
                <span className="tabular-nums text-muted-foreground">{t.pct.toFixed(0)}%</span>
                {i < tools.length - 1 && <span className="text-border ml-1">·</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {sessions === 0 && (
        <p className="text-[13px] text-muted-foreground text-center py-4">
          No AI sessions recorded yet.
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/components/lifetime-activity.tsx
git commit -m "feat(web): add LifetimeActivity component"
```

---

## Task 10: Mount on dashboard

**Files:**
- Modify: `src/web/app/page.tsx`

- [ ] **Step 1: Import the component**

Add near the other component imports (around line 8):

```typescript
import { LifetimeActivity } from "@/components/lifetime-activity";
```

- [ ] **Step 2: Render it between `StatsCards` and `DashboardCharts`**

Change the JSX block (around line 82) from:

```tsx
    <div className="space-y-5 max-w-6xl">
      <StatsCards jobs={jobs} runs={runs} health={health} />

      <DashboardCharts runs={runs} jobs={jobs} />
```

to:

```tsx
    <div className="space-y-5 max-w-6xl">
      <StatsCards jobs={jobs} runs={runs} health={health} />

      <LifetimeActivity />

      <DashboardCharts runs={runs} jobs={jobs} />
```

- [ ] **Step 3: Verify manually in the browser**

Run the daemon and web server:

```bash
npm run daemon &
npm run dev
```

Open `http://localhost:3500`. Expected:
- The new "Lifetime Activity" card appears above the existing "Activity — Last 7 Days" / "Job Health" row.
- Totals are non-zero (historical runs are backfilled on first load).
- Chart renders; hovering shows sessions + tool calls per day.
- Top tools strip lists at least one tool.

Stop both processes once verified.

- [ ] **Step 4: Commit**

```bash
git add src/web/app/page.tsx
git commit -m "feat(web): show lifetime activity on main dashboard"
```

---

## Task 11: Full suite + verification

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: all tests pass.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Final commit (if any type-check fixes were needed)**

```bash
git add -A
git commit -m "chore: fix types surfaced by build"
```

Skip this step if nothing changed.
