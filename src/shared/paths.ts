import fs from "fs";
import path from "path";

export function getDataDir(projectRoot: string): string {
  return path.join(projectRoot, "data");
}

export function getRunsDir(projectRoot: string): string {
  return path.join(projectRoot, "data", "runs");
}

export function getActivityDir(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), "activity");
}

export function getActivityRecordPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getActivityDir(projectRoot), jobId, `${runId}.json`);
}

export function getJobDir(projectRoot: string, jobId: string): string {
  return path.join(projectRoot, "data", "runs", jobId);
}

export function getRunDir(projectRoot: string, jobId: string, runId: string): string {
  return path.join(projectRoot, "data", "runs", jobId, runId);
}

export function getLogPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "output.log");
}

export function getStatusPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "status.json");
}

export function getMetaPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "meta.json");
}

export function getDaemonJsonPath(projectRoot: string): string {
  return path.join(projectRoot, "data", "daemon.json");
}

export function getLatestSymlink(projectRoot: string, jobId: string): string {
  return path.join(getJobDir(projectRoot, jobId), "latest");
}

export function getEvalPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "evaluation.json");
}

export function getStatsPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "stats.json");
}

export function getTracePath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "trace.jsonl");
}

export function getLatestRunStartedAt(projectRoot: string, jobId: string): string | null {
  try {
    const runId = fs.readlinkSync(getLatestSymlink(projectRoot, jobId));
    const meta = JSON.parse(fs.readFileSync(getMetaPath(projectRoot, jobId, runId), "utf-8"));
    return typeof meta?.startedAt === "string" ? meta.startedAt : null;
  } catch {
    return null;
  }
}

// job-runner's run ids start with the run's UTC start time (YYYY-MM-DDTHH-MM-SS-<hex>),
// so the greatest id is the most recently started run.
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/;

/**
 * Start time of the job's most recently started run, including one still running or one a
 * previous daemon left orphaned. The `latest` symlink moves only when a run completes, so
 * getLatestRunStartedAt misses those. Falls back to `latest` when the newest run directory
 * has no readable meta.json.
 */
export function getNewestRunStartedAt(projectRoot: string, jobId: string): string | null {
  let newest: string | undefined;
  try {
    for (const name of fs.readdirSync(getJobDir(projectRoot, jobId))) {
      if (RUN_ID_RE.test(name) && (newest === undefined || name > newest)) newest = name;
    }
  } catch {
    return null;
  }
  if (newest !== undefined) {
    try {
      const meta = JSON.parse(fs.readFileSync(getMetaPath(projectRoot, jobId, newest), "utf-8"));
      if (typeof meta?.startedAt === "string") return meta.startedAt;
    } catch {
      // unreadable: fall back to the last completed run
    }
  }
  return getLatestRunStartedAt(projectRoot, jobId);
}
