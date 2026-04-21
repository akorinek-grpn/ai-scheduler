import fs from "fs";
import path from "path";

import type { ActivityDayBucket, ActivityStatsResponse, RunMeta, RunStats } from "@shared/types";
import { getLogPath, getMetaPath, getRunsDir, getStatsPath } from "@shared/paths";

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
