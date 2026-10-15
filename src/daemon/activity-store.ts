import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getActivityDir, getActivityRecordPath } from "@shared/paths";
import {
  evaluationCostSchema,
  runCostSchema,
  runDecisionFileSchema,
} from "./costs";

export const runStatsSchema = z
  .object({
    toolCalls: z.number().int().nonnegative(),
    toolsByName: z.record(z.string(), z.number().int().nonnegative()),
    isAiSession: z.boolean(),
    finalized: z.boolean().optional(),
  })
  .refine(
    (stats) =>
      Object.values(stats.toolsByName).reduce(
        (total, count) => total + count,
        0,
      ) === stats.toolCalls,
  );

export const runVerdictSchema = z.object({
  severity: z.enum(["ok", "info", "warning", "critical"]),
  followUpNeeded: z.boolean(),
  source: z.enum(["haiku", "jev", "jev+haiku"]).optional(),
  // Benchmark mode: Haiku's verdict beside Jev's, kept so pruned runs still count as comparisons.
  haikuBenchmark: z
    .object({
      severity: z.enum(["ok", "info", "warning", "critical"]),
      followUpNeeded: z.boolean(),
    })
    .optional(),
});

/** What the cost dashboard reads from a run, kept so its cost outlives the pruned run directory. */
const preservedCostSchema = z.object({
  jobName: z.string(),
  execution: runCostSchema.nullable(),
  evaluation: evaluationCostSchema.nullable(),
  decision: runDecisionFileSchema.nullable(),
  verdict: runVerdictSchema.nullable(),
});

const activityRecordSchema = z.object({
  version: z.literal(1),
  jobId: z.string().min(1),
  runId: z.string().min(1),
  startedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  stats: runStatsSchema,
  // Absent on records written before costs were preserved: that run's cost is unknown.
  cost: preservedCostSchema.optional(),
  // Host that ran it (meta.json `host`); absent on records from before 2026-10-15.
  host: z.string().min(1).optional(),
});

export type ActivityRecord = z.infer<typeof activityRecordSchema>;
export type PreservedCost = z.infer<typeof preservedCostSchema>;

export function readActivityRecord(
  projectRoot: string,
  jobId: string,
  runId: string,
): ActivityRecord | null {
  const recordPath = getActivityRecordPath(projectRoot, jobId, runId);
  if (!fs.existsSync(recordPath)) return null;
  try {
    const record = activityRecordSchema.parse(
      JSON.parse(fs.readFileSync(recordPath, "utf-8")),
    );
    if (record.jobId !== jobId || record.runId !== runId)
      throw new Error("Activity record identity mismatch");
    return record;
  } catch (error) {
    throw new Error(`Cannot read preserved activity: ${recordPath}`, {
      cause: error,
    });
  }
}

export function writeActivityRecord(
  projectRoot: string,
  record: ActivityRecord,
): void {
  const validated = activityRecordSchema.parse(record);
  const recordPath = getActivityRecordPath(
    projectRoot,
    validated.jobId,
    validated.runId,
  );
  const content = JSON.stringify(validated);
  try {
    if (fs.readFileSync(recordPath, "utf-8") === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const temporaryPath = `${recordPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { flag: "wx", flush: true });
    fs.renameSync(temporaryPath, recordPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function readActivityRecords(
  projectRoot: string,
  // A mirror of another host can hold a file mid-sync; skip it there instead of failing the page.
  options: { tolerant?: boolean } = {},
): ActivityRecord[] {
  const activityDir = getActivityDir(projectRoot);
  if (!fs.existsSync(activityDir)) return [];
  const records: ActivityRecord[] = [];
  for (const job of fs.readdirSync(activityDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    const jobDir = path.join(activityDir, job.name);
    for (const file of fs.readdirSync(jobDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const recordPath = path.join(jobDir, file.name);
      try {
        const record = activityRecordSchema.parse(
          JSON.parse(fs.readFileSync(recordPath, "utf-8")),
        );
        if (
          getActivityRecordPath(projectRoot, record.jobId, record.runId) !==
          recordPath
        ) {
          throw new Error("Activity record identity does not match its path");
        }
        records.push(record);
      } catch (error) {
        if (options.tolerant) continue;
        throw new Error(`Cannot read preserved activity: ${recordPath}`, {
          cause: error,
        });
      }
    }
  }
  return records;
}
