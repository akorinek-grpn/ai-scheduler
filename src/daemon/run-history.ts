import fs from "node:fs";
import path from "node:path";
import { getRunDir, getRunsDir } from "@shared/paths";
import type { RunEvaluation, RunMeta, RunStatusFile, RunSummary } from "@shared/types";
import { readRunCost } from "./costs";

const cache = new Map<string, { signature: string; run: RunSummary }>();

function safeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !/[\\/\0]/.test(segment);
}

export function readRunSummary(projectRoot: string, jobId: string, runId: string): RunSummary | null {
  if (!safeSegment(jobId) || !safeSegment(runId) || runId === "latest") return null;
  const directory = getRunDir(projectRoot, jobId, runId);
  try {
    if (!fs.lstatSync(path.dirname(directory)).isDirectory() || !fs.lstatSync(directory).isDirectory()) return null;
    const signature = ["meta.json", "status.json", "costs.json", "evaluation-cost.json", "evaluation.json"].map((filename) => {
      try {
        const stat = fs.statSync(path.join(directory, filename));
        return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch { return "missing"; }
    }).join("|");
    const cached = cache.get(directory);
    if (cached?.signature === signature) return cached.run;
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(directory, "meta.json"), "utf8"));
    const status: RunStatusFile = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
    if (!meta?.jobConfig || typeof meta.jobConfig.name !== "string" || typeof status?.startedAt !== "string" || !Number.isFinite(Date.parse(status.startedAt))) return null;
    let evaluation: RunEvaluation | undefined;
    try { evaluation = JSON.parse(fs.readFileSync(path.join(directory, "evaluation.json"), "utf8")); } catch { evaluation = undefined; }
    const cost = readRunCost(projectRoot, jobId, runId);
    if (status.status === "running" && cost.coverage === "complete") cost.coverage = "partial";
    const configuredModel = meta.jobConfig.type !== "script" && !meta.jobConfig.command && typeof meta.jobConfig.model === "string"
      ? meta.jobConfig.model.trim() || undefined : undefined;
    const run: RunSummary = {
      jobId, runId, jobName: meta.jobConfig.name, directory: meta.jobConfig.directory,
      status: status.status, trigger: meta.trigger, startedAt: status.startedAt,
      finishedAt: status.finishedAt, exitCode: status.exitCode, evaluation, cost,
      configuredModel,
      ...(meta.catchupFor ? { catchupFor: meta.catchupFor } : {}),
    };
    if (cache.size >= 4096) cache.clear();
    cache.set(directory, { signature, run });
    return run;
  } catch {
    cache.delete(directory);
    return null;
  }
}

function directories(directory: string): string[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}

export function listRunSummaries(projectRoot: string, jobFilter?: string): RunSummary[] {
  const runs: RunSummary[] = [];
  const runsDirectory = getRunsDir(projectRoot);
  for (const jobId of directories(runsDirectory)) {
    if (jobFilter && jobFilter !== jobId) continue;
    for (const runId of directories(path.join(runsDirectory, jobId))) {
      const run = readRunSummary(projectRoot, jobId, runId);
      if (run) runs.push(run);
    }
  }
  return runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}
