import { spawn } from "child_process";
import fs from "fs";
import crypto from "crypto";
import { StringDecoder } from "node:string_decoder";
import type { AttemptCost, CostEntry } from "@shared/cost-types";
import { CostTracker, writeEvaluationCost, writeRunCost } from "./costs";
import { preserveRunActivity } from "./stats";
import { RunTraceWriter } from "./run-trace";
import { extractTextFromStreamJson } from "./stream-text";
import { ingestInnerSessions, sessionCostEntries } from "./inner-sessions";
import { detectUsageLimit } from "./usage-limit";
import {
  PRECONDITION_TIMEOUT_SEC,
  type JobConfig,
  type JobPriority,
  type TriggerType,
  type RunMeta,
  type RunStatus,
  type RunStatusFile,
  type RunStats,
  type UsageLimitHit,
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
  /** The cron slot the run stands for (ISO), recorded in meta.json; a deferred run's retry keeps it. */
  slot?: string;
  /** 1 or 2 when this run retries a deferred run of the same slot. */
  deferredRetry?: number;
}

const TASKPOLICY = "/usr/sbin/taskpolicy";

/** EX_TEMPFAIL: a precondition's "not now" (sysexits.h). */
export const PRECONDITION_DEFER_EXIT = 75;

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
  status: Exclude<RunStatus, "running">;
  exitCode: number | null;
  /** Set when the run is `blocked` because its output reported the account's usage limit. */
  usageLimit?: UsageLimitHit;
}

/** How much of the run's output is kept in memory for the usage-limit check (the line is short). */
const OUTPUT_TAIL_MAX = 65_536;

/** ISO instant `timeoutSec` after `from`: what SCHEDULER_DEADLINE carries. */
export function deadlineFrom(from: Date, timeoutSec: number): string {
  return new Date(from.getTime() + timeoutSec * 1000).toISOString();
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

/**
 * The run status for a finished attempt. `blocked` is the job's own list of "waiting on a
 * person" exit codes (scheduler.yaml `outcome_codes.blocked`); `killed` is an attempt that ended
 * on a signal rather than an exit code, which only the daemon's own stop or a SIGKILL does.
 */
export function classifyExit(
  code: number | null,
  timedOut: boolean,
  blockedCodes: readonly number[] = [],
): Exclude<RunStatus, "running" | "deferred"> {
  if (timedOut) return "timeout";
  if (code === null) return "killed";
  if (code === 0) return "success";
  if (blockedCodes.includes(code)) return "blocked";
  if (code === 2) return "partial";
  return "failed";
}

interface PreconditionResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Runs the job's `precondition` command in the job's directory with the job's env and waits for
 * it, up to `timeoutSec` (then SIGTERM, SIGKILL 5 s later). Output is returned for output.log.
 */
function runPrecondition(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number,
): Promise<PreconditionResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    let exited = false;
    const signalTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      setTimeout(() => {
        if (!exited) signalTree("SIGKILL");
      }, 5000).unref();
    }, timeoutSec * 1000);
    const finish = (exitCode: number | null, extra = ""): void => {
      exited = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        output: Buffer.concat(chunks).toString("utf8") + extra,
      });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, `\nPrecondition process error: ${err.message}\n`));
  });
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
    slot,
    deferredRetry,
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
    ...(slot !== undefined ? { slot } : {}),
    ...(deferredRetry !== undefined ? { deferredRetry } : {}),
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
  // (inner-sessions.ts), and since 2026-10-16 its token usage priced into costs.json, so the
  // ledger and the cost views no longer say null for every autopilot run. Best effort: a
  // failure here never touches the run's outcome.
  let sessionEntries: CostEntry[] = [];
  let sessionsFinal = false;
  let persistCurrentAttempt: (() => void) | null = null;
  const ingestSessions = (final: boolean): void => {
    if (!isScript) return;
    try {
      const sessions = ingestInnerSessions(getRunDir(projectRoot, jobId, runId), { final });
      sessionEntries = sessionCostEntries(sessions);
      sessionsFinal = final;
      persistCurrentAttempt?.();
    } catch (err) {
      console.error(
        `[sessions] ${jobId}/${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const sessionTimer = isScript ? setInterval(() => ingestSessions(false), 15_000) : null;
  sessionTimer?.unref();

  const timeout = jobConfig.timeout ?? defaultTimeout;
  const blockedCodes = jobConfig.outcome_codes?.blocked ?? [];

  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;

  // SCHEDULER_TRIGGER and, for a catch-up, SCHEDULER_CATCHUP_FOR (the missed slot, ISO)
  // let a job work on the slot's date instead of "today": a catch-up can start the next
  // morning. Never pass on a SCHEDULER_CATCHUP_FOR inherited by the daemon itself.
  // SCHEDULER_DEADLINE (2026-10-16) is the ISO instant the run is killed at: the job's
  // `timeout` after the attempt starts (the precondition gets it from the run's start, the
  // earliest it can be). A review round uses it to stop starting PRs it cannot finish.
  const jobEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SCHEDULER_TRIGGER: trigger,
    SCHEDULER_DEADLINE: deadlineFrom(new Date(meta.startedAt), timeout),
  };
  delete jobEnv.SCHEDULER_CATCHUP_FOR;
  if (catchupFor !== undefined) jobEnv.SCHEDULER_CATCHUP_FOR = catchupFor;

  // The last OUTPUT_TAIL_MAX characters of the current attempt's output (stdout text and
  // stderr), for the usage-limit check once the attempt has failed (usage-limit.ts).
  let outputTail = "";
  const keepTail = (chunk: string): void => {
    if (!chunk) return;
    outputTail = (outputTail + chunk).slice(-OUTPUT_TAIL_MAX);
  };
  let usageLimit: UsageLimitHit | undefined;

  const isAiSession = jobConfig.type !== "script";
  const attemptCosts: AttemptCost[] = [];
  writeEvaluationCost(projectRoot, jobId, runId, "pending");

  const writeStats = (status: RunResult["status"]): void => {
    const stats: RunStats = {
      toolCalls,
      toolsByName,
      // A deferred claude job never started its session, so it is not one in the activity stats.
      isAiSession: isAiSession && status !== "deferred",
      finalized: true,
    };
    fs.writeFileSync(
      getStatsPath(projectRoot, jobId, runId),
      JSON.stringify(stats, null, 2),
    );
  };

  /** Writes status.json, stats, the activity record and the `latest` symlink once, at the end. */
  const finalize = async (
    status: RunResult["status"],
    exitCode: number | null,
  ): Promise<RunResult> => {
    await new Promise<void>((res) => logStream.end(res));
    await trace?.close();
    if (sessionTimer) clearInterval(sessionTimer);
    ingestSessions(true);

    const finalStatus: RunStatusFile = {
      status,
      exitCode,
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      ...(usageLimit ? { blockedReason: "usage-limit" as const, usageLimit } : {}),
    };
    writeStats(status);
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

    return { runId, status, exitCode, ...(usageLimit ? { usageLimit } : {}) };
  };

  // The precondition runs first, in the job's directory with the job's env, and decides whether
  // the command or Claude session starts at all. Exit 75 defers the run (the engine retries the
  // slot later); any other failure is the run's failure, with the output in output.log.
  if (jobConfig.precondition) {
    const limit = jobConfig.precondition_timeout ?? PRECONDITION_TIMEOUT_SEC;
    logStream.write(`=== precondition: ${jobConfig.precondition} ===\n`);
    const check = await runPrecondition(
      jobConfig.precondition,
      jobConfig.directory,
      { ...jobEnv, SCHEDULER_JOB_ID: jobId, SCHEDULER_RUN_ID: runId },
      limit,
    );
    if (check.output) logStream.write(check.output.endsWith("\n") ? check.output : `${check.output}\n`);
    if (check.timedOut) {
      logStream.write(`=== precondition timed out after ${limit}s: run failed ===\n`);
      writeRunCost(projectRoot, jobId, runId, []);
      return finalize("failed", check.exitCode);
    }
    if (check.exitCode === PRECONDITION_DEFER_EXIT) {
      logStream.write(
        `=== precondition exit ${PRECONDITION_DEFER_EXIT}: deferred, nothing ran ===\n`,
      );
      writeRunCost(projectRoot, jobId, runId, []);
      return finalize("deferred", check.exitCode);
    }
    if (check.exitCode !== 0) {
      logStream.write(
        `=== precondition exit ${check.exitCode ?? "none"}: run failed, nothing ran ===\n`,
      );
      writeRunCost(projectRoot, jobId, runId, []);
      return finalize("failed", check.exitCode);
    }
    logStream.write("=== precondition ok ===\n");
  }

  // Run the child process once. Resolves with the computed status/exit code
  // but does NOT finalize the run record, so runJob can retry before committing
  // the final status + latest symlink. The shared logStream stays open across
  // attempts (piped with `end: false`) and is closed once during finalization.
  const runAttempt = (
    attempt: number,
  ): Promise<{
    status: RunResult["status"];
    exitCode: number | null;
  }> =>
    new Promise((resolve) => {
      trace?.startAttempt(attempt);
      const costTracker = new CostTracker(
        isCustomCommand ? "script" : "claude",
        attempt,
      );
      const persistCost = (): void => {
        const snapshot = costTracker.snapshot();
        const priced = sessionEntries.every((entry) => entry.costUsd !== null);
        // A script that reports nothing itself is complete once its inner sessions are final
        // and every one of them has a list price; its own reports still govern otherwise.
        const complete =
          snapshot.entries.length > 0
            ? snapshot.complete && priced
            : sessionsFinal && sessionEntries.length > 0 && priced;
        attemptCosts[attempt - 1] = {
          attempt,
          complete,
          entries: [...snapshot.entries, ...sessionEntries],
        };
        writeRunCost(projectRoot, jobId, runId, attemptCosts);
      };
      persistCurrentAttempt = persistCost;
      persistCost();
      // detached: the child leads its own process group, so a timeout can
      // signal the whole tree. Without it we signal only the spawned `/bin/sh`
      // and its npm/node grandchildren survive, keep the inherited stdout pipe
      // open (so `close` never fires) and pin the run at "running" forever -
      // which makes the daemon skip every later run of that job as "still
      // active" until it is restarted.
      outputTail = "";
      const child = spawn(spawnTarget.command, spawnTarget.args, {
        cwd: jobConfig.directory,
        env: {
          ...jobEnv,
          SCHEDULER_DEADLINE: deadlineFrom(new Date(), timeout),
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
      const tailDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let buffer = "";
      let oversizedLine = false;
      const consumeLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (costTracker.consume(trimmed)) persistCost();
        if (isCustomCommand) return;
        trace?.consume(trimmed);
        const text = extractTextFromStreamJson(trimmed);
        if (text) {
          logStream.write(text);
          keepTail(text);
        }
        for (const name of countToolUseInStreamEvent(trimmed)) {
          toolCalls += 1;
          toolsByName[name] = (toolsByName[name] ?? 0) + 1;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (isCustomCommand) keepTail(tailDecoder.write(chunk));
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
      child.stderr.on("data", (chunk: Buffer) => keepTail(stderrDecoder.write(chunk)));

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
        resolve({ status: classifyExit(code, isTimedOut, blockedCodes), exitCode: code });
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
  // maxRetries x timeout of wall-clock for nothing. A blocked run waits on a
  // person, and a killed one was stopped on purpose: neither is retried either.
  let result: { status: RunResult["status"]; exitCode: number | null } = {
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
    // The account's usage window is exhausted (2026-10-16): every Claude session on this Mac
    // fails the same way until the reset, so the run is `blocked` (reason usage-limit), not
    // retried, and the engine holds the Mac's Claude jobs until then.
    if (result.status === "failed" || result.status === "partial") {
      const hit = detectUsageLimit(outputTail);
      if (hit) {
        usageLimit = hit;
        result = { status: "blocked", exitCode: result.exitCode };
        logStream.write(
          `\n=== exit ${result.exitCode ?? "none"}: the Claude account's ${hit.kind} usage limit is exhausted ` +
            `("${hit.text}"): blocked, not retried; jobs that start a Claude session are held until ` +
            `${hit.resetsAt ?? "the text is checked again in 30 minutes"}. ===\n`,
        );
        break;
      }
    }
    if (result.status === "timeout") {
      logStream.write(
        `\n=== run timed out after ${timeout}s and was killed. Not retrying: ` +
          `a timed-out run spent its full time budget and may already have side ` +
          `effects; raise 'timeout' in scheduler.yaml if this job needs more time. ===\n`,
      );
      break;
    }
    if (result.status === "blocked") {
      logStream.write(
        `\n=== exit ${result.exitCode}: blocked, waiting on a person (outcome_codes.blocked). Not retrying. ===\n`,
      );
      break;
    }
    if (result.status === "killed") {
      logStream.write(
        `\n=== the process ended on a signal, without an exit code: killed. Not retrying. ===\n`,
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
  return finalize(result.status, result.exitCode);
}
