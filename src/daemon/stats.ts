import fs from "fs";
import path from "path";

import type { ActivityDayBucket, ActivityStatsResponse, RunMeta, RunStats, RunStatusFile } from "@shared/types";
import { getLogPath, getMetaPath, getRunsDir, getStatsPath, getStatusPath } from "@shared/paths";
import { readActivityRecord, readActivityRecords, runStatsSchema, writeActivityRecord, type ActivityRecord } from "./activity-store";

const TOOL_MARKER = /^> \[([^\]]+)\]/;

function readRunStatus(projectRoot: string, jobId: string, runId: string): RunStatusFile["status"] | undefined {
  try {
    return (JSON.parse(fs.readFileSync(getStatusPath(projectRoot, jobId, runId), "utf-8")) as RunStatusFile).status;
  } catch {
    return undefined;
  }
}

export function discardProvisionalRunStats(projectRoot: string, jobId: string, runId: string): void {
  if (readRunStatus(projectRoot, jobId, runId) !== "running") return;
  const statsPath = getStatsPath(projectRoot, jobId, runId);
  if (!fs.existsSync(statsPath)) return;
  const content = fs.readFileSync(statsPath, "utf-8");
  let finalized = false;
  try {
    finalized = runStatsSchema.safeParse(JSON.parse(content)).data?.finalized === true;
  } catch {
    finalized = false;
  }
  if (!finalized) fs.rmSync(statsPath);
}

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
  const running = readRunStatus(projectRoot, jobId, runId) === "running";
  if (fs.existsSync(statsPath)) {
    try {
      const stats = runStatsSchema.parse(JSON.parse(fs.readFileSync(statsPath, "utf-8")));
      if (!running || stats.finalized === true) return stats;
    } catch {
      // Corrupt — fall through to backfill.
    }
  }

  if (!running) {
    const preserved = readActivityRecord(projectRoot, jobId, runId);
    if (preserved) return preserved.stats;
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
  if (isAiSession && !fs.existsSync(getLogPath(projectRoot, jobId, runId))) return null;

  const counts = isAiSession
    ? backfillFromLog(getLogPath(projectRoot, jobId, runId))
    : { toolCalls: 0, toolsByName: {} };

  const stats: RunStats = { ...counts, isAiSession };
  if (running) return stats;

  try {
    fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  } catch {
    // Non-fatal — return stats even if we couldn't persist.
  }

  return stats;
}

function readRunActivity(projectRoot: string, jobId: string, runId: string): {
  record: ActivityRecord;
  completed: boolean;
} | null {
  let meta: RunMeta;
  try {
    meta = JSON.parse(fs.readFileSync(getMetaPath(projectRoot, jobId, runId), "utf-8"));
    if (typeof meta?.startedAt !== "string" || !Number.isFinite(Date.parse(meta.startedAt))) return null;
  } catch {
    return null;
  }
  const status = readRunStatus(projectRoot, jobId, runId);
  const stats = getOrBackfillRunStats(projectRoot, jobId, runId);
  if (!stats) return null;
  return {
    record: { version: 1, jobId, runId, startedAt: meta.startedAt, stats },
    completed: status !== undefined && ["success", "partial", "failed", "timeout"].includes(status),
  };
}

export function preserveRunActivity(projectRoot: string, jobId: string, runId: string): boolean {
  try {
    const activity = readRunActivity(projectRoot, jobId, runId);
    if (!activity?.completed) return false;
    writeActivityRecord(projectRoot, activity.record);
    return true;
  } catch (error) {
    console.warn(`[activity] Could not preserve ${jobId}/${runId}:`, error);
    return false;
  }
}

function syncRetainedActivity(projectRoot: string): ActivityRecord[] {
  const runsDir = getRunsDir(projectRoot);
  if (!fs.existsSync(runsDir)) return [];
  const records: ActivityRecord[] = [];
  for (const job of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    for (const run of fs.readdirSync(path.join(runsDir, job.name), { withFileTypes: true })) {
      if (!run.isDirectory() || run.name === "latest") continue;
      const activity = readRunActivity(projectRoot, job.name, run.name);
      if (!activity) continue;
      if (activity.completed) writeActivityRecord(projectRoot, activity.record);
      records.push(activity.record);
    }
  }
  return records;
}

export function backfillActivityHistory(projectRoot: string): void {
  syncRetainedActivity(projectRoot);
}

function buildEmptyDailyBuckets(days: number): ActivityDayBucket[] {
  const buckets: ActivityDayBucket[] = [];
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.push({ date: d.toISOString().slice(0, 10), sessions: 0, toolCalls: 0 });
  }
  return buckets;
}

export function getActivityStats(projectRoot: string, days: number): ActivityStatsResponse {
  const retained = syncRetainedActivity(projectRoot);
  const records = new Map<string, ActivityRecord>();
  for (const record of [...readActivityRecords(projectRoot), ...retained]) {
    records.set(JSON.stringify([record.jobId, record.runId]), record);
  }
  const daily = buildEmptyDailyBuckets(days);
  const bucketIndex = new Map(daily.map((b) => [b.date, b]));

  const lifetime = {
    sessions: 0,
    toolCalls: 0,
    toolsByName: {} as Record<string, number>,
  };

  for (const { startedAt, stats } of records.values()) {
    if (!stats.isAiSession) continue;
    lifetime.sessions += 1;
    lifetime.toolCalls += stats.toolCalls;
    for (const [name, count] of Object.entries(stats.toolsByName)) {
      lifetime.toolsByName[name] = (lifetime.toolsByName[name] ?? 0) + count;
    }

    const bucket = bucketIndex.get(new Date(startedAt).toISOString().slice(0, 10));
    if (bucket) {
      bucket.sessions += 1;
      bucket.toolCalls += stats.toolCalls;
    }
  }

  return { lifetime, daily };
}
