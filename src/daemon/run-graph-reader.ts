import fs from "node:fs";
import path from "node:path";
import {
  getLogPath,
  getMetaPath,
  getRunDir,
  getStatusPath,
  getTracePath,
} from "@shared/paths";
import {
  buildGraphFromAgentLog,
  buildGraphFromScriptLog,
  buildGraphFromTrace,
  parseTraceLines,
  type RunGraphContext,
} from "@shared/run-graph";
import type { RunGraph } from "@shared/run-graph-types";
import type { RunStatus } from "@shared/types";
import { safeSegment } from "./run-history";

// SHORTCUT: output.log is read into memory from the start, capped at 8 MB (the
// largest logs today are ~700 KB); a longer log is cut and a note says so.
// Upgrade to a streaming line reader if logs routinely exceed the cap or their
// tail starts to matter for the diagram.
const MAX_LOG_BYTES = 8 * 1024 * 1024;

const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "success",
  "partial",
  "failed",
  "timeout",
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** File content, or null when the file does not exist. Other read errors propagate. */
function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** The first MAX_LOG_BYTES of output.log, cut back to the last whole line when longer. */
function readLogHead(logPath: string): {
  content: string;
  totalBytes: number;
  cut: boolean;
} {
  let fd: number;
  try {
    fd = fs.openSync(logPath, "r");
  } catch (error) {
    if (isMissing(error)) return { content: "", totalBytes: 0, cut: false };
    throw error;
  }
  try {
    const totalBytes = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(totalBytes, MAX_LOG_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      const read = fs.readSync(
        fd,
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (read === 0) break;
      filled += read;
    }
    const cut = totalBytes > MAX_LOG_BYTES;
    let content = buffer.subarray(0, filled).toString("utf-8");
    if (cut) content = content.slice(0, content.lastIndexOf("\n") + 1);
    return { content, totalBytes, cut };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * How many attempts costs.json recorded: runJob writes an attempt's entry when
 * it starts, before any output. Undefined when the run has no such record
 * (runs from before cost tracking).
 */
function recordedAttempts(runDir: string): number | undefined {
  const costs = readJson(path.join(runDir, "costs.json"));
  if (
    !isRecord(costs) ||
    !Array.isArray(costs.attempts) ||
    costs.attempts.length === 0
  )
    return undefined;
  let count = costs.attempts.length;
  for (const entry of costs.attempts) {
    const attempt = isRecord(entry) ? entry.attempt : undefined;
    if (typeof attempt === "number" && Number.isInteger(attempt))
      count = Math.max(count, attempt);
  }
  return count;
}

/**
 * The Diagram model for one run, or null when the ids are unsafe or the run
 * does not exist. Built from trace.jsonl when the run has one, otherwise
 * reconstructed from output.log.
 */
export function readRunGraph(
  projectRoot: string,
  jobId: string,
  runId: string,
): RunGraph | null {
  // The same guard as readRunSummary: "latest" is the per-job symlink, not a
  // run, and only real directories are runs - so a symlinked job or run
  // directory, or any spelling of "latest" on a case-insensitive volume, is not.
  if (!safeSegment(jobId) || !safeSegment(runId) || runId === "latest")
    return null;
  const runDir = getRunDir(projectRoot, jobId, runId);
  try {
    if (
      !fs.lstatSync(path.dirname(runDir)).isDirectory() ||
      !fs.lstatSync(runDir).isDirectory()
    )
      return null;
  } catch {
    return null;
  }

  const meta = readJson(getMetaPath(projectRoot, jobId, runId));
  if (!isRecord(meta) || !isRecord(meta.jobConfig)) return null;

  // status.json is written right after meta.json; until then (or if it is
  // unreadable) the run is treated as still running.
  const rawStatus = readJson(getStatusPath(projectRoot, jobId, runId));
  const status =
    isRecord(rawStatus) && RUN_STATUSES.includes(rawStatus.status as RunStatus)
      ? rawStatus
      : null;
  const metaStartedAt =
    typeof meta.startedAt === "string" ? meta.startedAt : "";
  const ctx: RunGraphContext = {
    jobId,
    runId,
    kind: meta.jobConfig.type === "script" ? "script" : "agent",
    status: status ? (status.status as RunStatus) : "running",
    exitCode:
      status && typeof status.exitCode === "number" ? status.exitCode : null,
    startedAt:
      status && typeof status.startedAt === "string"
        ? status.startedAt
        : metaStartedAt,
    finishedAt:
      status && typeof status.finishedAt === "string"
        ? status.finishedAt
        : null,
  };

  const trace = readIfExists(getTracePath(projectRoot, jobId, runId));
  if (trace !== null) return buildGraphFromTrace(parseTraceLines(trace), ctx);

  const log = readLogHead(getLogPath(projectRoot, jobId, runId));
  const expectedAttempts = recordedAttempts(runDir);
  const logCtx: RunGraphContext =
    expectedAttempts === undefined ? ctx : { ...ctx, expectedAttempts };
  const graph =
    ctx.kind === "agent"
      ? buildGraphFromAgentLog(log.content, logCtx)
      : buildGraphFromScriptLog(log.content, logCtx);
  if (log.cut) {
    const megabytes = (log.totalBytes / (1024 * 1024)).toFixed(1);
    graph.notes.push(
      `output.log is ${megabytes} MB; only its first ${MAX_LOG_BYTES / (1024 * 1024)} MB were read, so later output is not shown.`,
    );
  }
  return graph;
}
