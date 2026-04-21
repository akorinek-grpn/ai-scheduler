import fs from "fs";

import type { RunMeta, RunStats } from "@shared/types";
import { getLogPath, getMetaPath, getStatsPath } from "@shared/paths";

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
