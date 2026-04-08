import fs from "fs";
import path from "path";
import { getJobDir } from "@shared/paths";

export function pruneOldRuns(projectRoot: string, jobId: string, retainCount: number): void {
  const jobDir = getJobDir(projectRoot, jobId);

  if (!fs.existsSync(jobDir)) return;

  const entries = fs.readdirSync(jobDir).filter((d) => {
    if (d === "latest") return false;
    return fs.statSync(path.join(jobDir, d)).isDirectory();
  });

  if (entries.length <= retainCount) return;

  entries.sort();

  const toRemove = entries.slice(0, entries.length - retainCount);
  for (const runId of toRemove) {
    fs.rmSync(path.join(jobDir, runId), { recursive: true, force: true });
  }
}
