import path from "path";

export function getDataDir(projectRoot: string): string {
  return path.join(projectRoot, "data");
}

export function getRunsDir(projectRoot: string): string {
  return path.join(projectRoot, "data", "runs");
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
