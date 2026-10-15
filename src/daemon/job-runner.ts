import { spawn } from "child_process";
import fs from "fs";
import crypto from "crypto";
import { StringDecoder } from "node:string_decoder";
import type { AttemptCost } from "@shared/cost-types";
import { CostTracker, writeEvaluationCost, writeRunCost } from "./costs";
import { preserveRunActivity } from "./stats";
import { RunTraceWriter } from "./run-trace";
import { extractTextFromStreamJson } from "./stream-text";
import { ingestInnerSessions } from "./inner-sessions";
import type {
  JobConfig,
  JobPriority,
  TriggerType,
  RunMeta,
  RunStatus,
  RunStatusFile,
  RunStats,
} from "@shared/types";
import {
  getRunDir,
  getLogPath,
  getStatusPath,
  getMetaPath,
  getStatsPath,
  getLatestSymlink,
  getTracePath,
} from "@shared/paths";

interface RunJobOptions {
  jobId: string;
  jobConfig: JobConfig;
  projectRoot: string;
  trigger: TriggerType;
  command?: string;
  args?: string[];
  defaultTimeout?: number;
  catchupFor?: string;
  /** Grace period (ms) after SIGTERM before escalating to SIGKILL on timeout. Default 5000. */
  sigkillGraceMs?: number;
  /** Extra attempts after the first if the run does not succeed. Default 0 (no retries). */
  maxRetries?: number;
  /**
   * CPU/IO priority of the job's process tree. The cron engine passes the resolved
   * scheduler.yaml value (job `priority`, else `defaults.priority`, "background" by default);
   * a direct caller that passes nothing runs at normal priority.
   */
  priority?: JobPriority;
  /** This host's name (config.host), recorded in meta.json so mirrored history keeps its origin. */
  host?: string;
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

/**
 * Wrap a command so the job yields to interactive work. On macOS `taskpolicy -c background`
 * execs the program in place (same pid, so runJob's process-group signalling still reaches
 * the whole tree); a background-clamped tree gets full CPU on an idle machine and only steps
 * aside under contention. Elsewhere `nice -n 19` lowers CPU priority only. Windows has no
 * equivalent here and runs the command unchanged.
 */
export function withPriority(
  command: string,
  args: string[],
  priority: JobPriority,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (priority !== "background" || platform === "win32")
    return { command, args };
  if (platform === "darwin" && fs.existsSync(TASKPOLICY)) {
    return {
      command: TASKPOLICY,
      args: ["-c", "background", command, ...args],
    };
  }
  return { command: "nice", args: ["-n", "19", command, ...args] };
}

interface RunResult {
  runId: string;
  status: "success" | "partial" | "failed" | "timeout";
  exitCode: number | null;
}

function generateRunId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${hash}`;
}

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

export async function runJob(options: RunJobOptions): Promise<RunResult> {
  const {
    jobId,
    jobConfig,
    projectRoot,
    trigger,
    defaultTimeout = 300,
    catchupFor,
    sigkillGraceMs = 5000,
    maxRetries = 0,
    priority = "normal",
    host,
  } = options;
  const runId = generateRunId();
  const runDir = getRunDir(projectRoot, jobId, runId);

  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobId,
    runId,
    jobConfig,
    trigger,
    startedAt: new Date().toISOString(),
    ...(catchupFor !== undefined ? { catchupFor } : {}),
    ...(host ? { host } : {}),
  };
  fs.writeFileSync(
    getMetaPath(projectRoot, jobId, runId),
    JSON.stringify(meta, null, 2),
  );

  const statusFile: RunStatusFile = {
    status: "running",
    exitCode: null,
    startedAt: meta.startedAt,
    finishedAt: null,
  };
  fs.writeFileSync(
    getStatusPath(projectRoot, jobId, runId),
    JSON.stringify(statusFile, null, 2),
  );

  const logPath = getLogPath(projectRoot, jobId, runId);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const isScript = jobConfig.type === "script";
  let command: string;
  let args: string[];

  if (options.command !== undefined || options.args !== undefined) {
    // Explicit override (e.g., from tests)
    command = options.command ?? "claude";
    args = options.args ?? [];
  } else if (isScript) {
    // Script mode: run command via shell
    command = "/bin/sh";
    args = ["-c", jobConfig.command!];
  } else {
    // Claude mode (default)
    command = "claude";
    args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      ...(jobConfig.skip_permissions ? ["--dangerously-skip-permissions"] : []),
      ...(jobConfig.model ? ["--model", jobConfig.model] : []),
      jobConfig.prompt!,
    ];
  }

  const isCustomCommand =
    isScript || options.command !== undefined || options.args !== undefined;

  const spawnTarget = withPriority(command, args, priority);

  // Claude runs also record a compact event trace (trace.jsonl) for the run's
  // Diagram view. Scripts and explicit command overrides have no stream-json.
  const trace = isCustomCommand
    ? null
    : new RunTraceWriter(getTracePath(projectRoot, jobId, runId));

  // A script that starts its own Claude session (autopilot's b2c-toolkit runs) gets that
  // session's text and trace copied into the run, every 15 s while it runs and once at the end
  // (inner-sessions.ts). Best effort: a failure here never touches the run's outcome.
  const ingestSessions = (final: boolean): void => {
    if (!isScript) return;
    try {
      ingestInnerSessions(getRunDir(projectRoot, jobId, runId), { final });
    } catch (err) {
      console.error(
        `[sessions] ${jobId}/${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const sessionTimer = isScript ? setInterval(() => ingestSessions(false), 15_000) : null;
  sessionTimer?.unref();

  const timeout = jobConfig.timeout ?? defaultTimeout;

  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;

  // SCHEDULER_TRIGGER and, for a catch-up, SCHEDULER_CATCHUP_FOR (the missed slot, ISO)
  // let a job work on the slot's date instead of "today": a catch-up can start the next
  // morning. Never pass on a SCHEDULER_CATCHUP_FOR inherited by the daemon itself.
  const jobEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SCHEDULER_TRIGGER: trigger,
  };
  delete jobEnv.SCHEDULER_CATCHUP_FOR;
  if (catchupFor !== undefined) jobEnv.SCHEDULER_CATCHUP_FOR = catchupFor;

  const isAiSession = jobConfig.type !== "script";
  const attemptCosts: AttemptCost[] = [];
  writeEvaluationCost(projectRoot, jobId, runId, "pending");

  const writeStats = (): void => {
    const stats: RunStats = {
      toolCalls,
      toolsByName,
      isAiSession,
      finalized: true,
    };
    fs.writeFileSync(
      getStatsPath(projectRoot, jobId, runId),
      JSON.stringify(stats, null, 2),
    );
  };

  // Run the child process once. Resolves with the computed status/exit code
  // but does NOT finalize the run record, so runJob can retry before committing
  // the final status + latest symlink. The shared logStream stays open across
  // attempts (piped with `end: false`) and is closed once during finalization.
  const runAttempt = (
    attempt: number,
  ): Promise<{
    status: RunStatus;
    exitCode: number | null;
  }> =>
    new Promise((resolve) => {
      trace?.startAttempt(attempt);
      const costTracker = new CostTracker(
        isCustomCommand ? "script" : "claude",
        attempt,
      );
      const persistCost = (): void => {
        attemptCosts[attempt - 1] = costTracker.snapshot();
        writeRunCost(projectRoot, jobId, runId, attemptCosts);
      };
      persistCost();
      // detached: the child leads its own process group, so a timeout can
      // signal the whole tree. Without it we signal only the spawned `/bin/sh`
      // and its npm/node grandchildren survive, keep the inherited stdout pipe
      // open (so `close` never fires) and pin the run at "running" forever -
      // which makes the daemon skip every later run of that job as "still
      // active" until it is restarted.
      const child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd: jobConfig.directory,
        env: {
          ...jobEnv,
          SCHEDULER_JOB_ID: jobId,
          SCHEDULER_RUN_ID: runId,
          SCHEDULER_ATTEMPT: String(attempt),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      if (isCustomCommand) {
        // For test commands (echo, sh, etc.) - pipe directly
        child.stdout.pipe(logStream, { end: false });
      }
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let oversizedLine = false;
      const consumeLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (costTracker.consume(trimmed)) persistCost();
        if (isCustomCommand) return;
        trace?.consume(trimmed);
        const text = extractTextFromStreamJson(trimmed);
        if (text) logStream.write(text);
        for (const name of countToolUseInStreamEvent(trimmed)) {
          toolCalls += 1;
          toolsByName[name] = (toolsByName[name] ?? 0) + 1;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        const lines = (buffer + decoder.write(chunk)).split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!oversizedLine) consumeLine(line);
          oversizedLine = false;
        }
        if (isCustomCommand && buffer.length > 1_048_576) {
          buffer = "";
          oversizedLine = true;
        }
      });
      const finishOutput = (): void => {
        if (!oversizedLine) consumeLine(buffer + decoder.end());
        buffer = "";
        persistCost();
      };

      child.stderr.pipe(logStream, { end: false });

      let isTimedOut = false;
      let processExited = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      // Signal the child's whole process group (negative pid). Falls back to
      // the child alone if the group is already gone, so a late signal can
      // never throw ESRCH into the timer callback.
      const signalTree = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already dead
          }
        }
      };

      const timer = setTimeout(() => {
        isTimedOut = true;
        signalTree("SIGTERM");
        // `child.killed` only reflects that a signal was *sent*, not that the
        // process died. A child that ignores SIGTERM (e.g. a hung `claude -p`)
        // would otherwise never be escalated to SIGKILL. Track real exit instead.
        sigkillTimer = setTimeout(() => {
          if (!processExited) signalTree("SIGKILL");
        }, sigkillGraceMs);
      }, timeout * 1000);

      child.on("close", (code) => {
        finishOutput();
        processExited = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);

        const status: RunStatus = isTimedOut
          ? "timeout"
          : code === 0
            ? "success"
            : code === 2
              ? "partial"
              : "failed";
        resolve({ status, exitCode: code });
      });

      child.on("error", (err) => {
        processExited = true;
        clearTimeout(timer);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        logStream.write(`\nProcess error: ${err.message}\n`);
        resolve({ status: "failed", exitCode: null });
      });
    });

  // Retry until success or attempts are exhausted. Only failed / partial are
  // retryable - transient failures like the weekly-ops LiteLLM socket error
  // recover on a later attempt. A timeout is NOT retried: the attempt used its
  // full time budget doing real work (possibly with side effects, e.g. PR
  // comments already posted), so a rerun duplicates work and burns another
  // maxRetries x timeout of wall-clock for nothing.
  let result: { status: RunStatus; exitCode: number | null } = {
    status: "failed",
    exitCode: null,
  };
  let attemptsRun = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logStream.write(
        `\n=== retry ${attempt}/${maxRetries} (previous attempt: ${result.status}) ===\n`,
      );
    }
    result = await runAttempt(attempt + 1);
    attemptsRun += 1;
    if (result.status === "success") break;
    if (result.status === "timeout") {
      logStream.write(
        `\n=== run timed out after ${timeout}s and was killed. Not retrying: ` +
          `a timed-out run spent its full time budget and may already have side ` +
          `effects; raise 'timeout' in scheduler.yaml if this job needs more time. ===\n`,
      );
      break;
    }
  }
  if (result.status === "failed" || result.status === "partial") {
    logStream.write(
      `\n=== giving up after ${attemptsRun} attempt${attemptsRun === 1 ? "" : "s"}: ` +
        `final status ${result.status} (exit code ${result.exitCode}) ===\n`,
    );
  }

  // Finalize the run record once, after all attempts. Wait for the log to
  // flush so callers reading output.log see the complete content.
  await new Promise<void>((res) => logStream.end(res));
  await trace?.close();
  if (sessionTimer) clearInterval(sessionTimer);
  ingestSessions(true);

  const finalStatus: RunStatusFile = {
    status: result.status,
    exitCode: result.exitCode,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
  };
  writeStats();
  fs.writeFileSync(
    getStatusPath(projectRoot, jobId, runId),
    JSON.stringify(finalStatus, null, 2),
  );
  preserveRunActivity(projectRoot, jobId, runId);

  const symlinkPath = getLatestSymlink(projectRoot, jobId);
  try {
    fs.unlinkSync(symlinkPath);
  } catch {
    // symlink doesn't exist yet
  }
  fs.symlinkSync(runId, symlinkPath);

  return {
    runId,
    status: result.status as RunResult["status"],
    exitCode: result.exitCode,
  };
}
