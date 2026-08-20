import { spawn } from "child_process";
import fs from "fs";
import crypto from "crypto";
import type {
  JobConfig,
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

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return input.command ? `$ ${input.command}` : "";
    case "Read":
      return input.file_path ? `Reading ${input.file_path}` : "";
    case "Write":
      return input.file_path ? `Writing ${input.file_path}` : "";
    case "Edit":
      return input.file_path ? `Editing ${input.file_path}` : "";
    case "Glob":
      return input.pattern ? `Glob: ${input.pattern}` : "";
    case "Grep":
      return input.pattern ? `Grep: ${input.pattern}` : "";
    case "Skill":
      return input.skill ? `Skill: ${input.skill}` : "";
    case "Agent":
      return input.description ? `Agent: ${input.description}` : "";
    default:
      return "";
  }
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n... (${lines.length - maxLines} more lines)`
  );
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

function extractTextFromStreamJson(line: string): string | null {
  try {
    const event = JSON.parse(line);

    // Assistant message — extract text AND tool calls
    if (event.type === "assistant" && event.message?.content) {
      const parts: string[] = [];

      for (const block of event.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          parts.push(block.text);
        }
        if (block.type === "tool_use") {
          const detail = formatToolInput(block.name, block.input ?? {});
          if (detail) {
            parts.push(`\n> [${block.name}] ${detail}\n`);
          } else {
            parts.push(`\n> [${block.name}]\n`);
          }
        }
      }

      if (parts.length > 0) return parts.join("");
    }

    // Content block delta (streaming partial text)
    if (event.type === "content_block_delta" && event.delta?.text) {
      return event.delta.text;
    }

    // Tool result — nested inside "user" message events
    if (event.type === "user" && event.message?.content) {
      const contents = Array.isArray(event.message.content)
        ? event.message.content
        : [event.message.content];

      const parts: string[] = [];
      for (const block of contents) {
        if (block.type === "tool_result") {
          let text = "";
          if (typeof block.content === "string") {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join("");
          }
          if (text.trim()) {
            parts.push(truncate(text, 50));
          }
        }
      }
      if (parts.length > 0) return parts.join("\n") + "\n";
    }

    // Final result
    if (event.type === "result" && event.result?.trim()) {
      return event.result;
    }
  } catch {
    // Not valid JSON — could be partial line, ignore
  }
  return null;
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

  const timeout = jobConfig.timeout ?? defaultTimeout;

  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;

  const isAiSession = jobConfig.type !== "script";

  const writeStats = (): void => {
    const stats: RunStats = { toolCalls, toolsByName, isAiSession };
    fs.writeFileSync(
      getStatsPath(projectRoot, jobId, runId),
      JSON.stringify(stats, null, 2),
    );
  };

  // Run the child process once. Resolves with the computed status/exit code
  // but does NOT finalize the run record, so runJob can retry before committing
  // the final status + latest symlink. The shared logStream stays open across
  // attempts (piped with `end: false`) and is closed once during finalization.
  const runAttempt = (): Promise<{
    status: RunStatus;
    exitCode: number | null;
  }> =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: jobConfig.directory,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (isCustomCommand) {
        // For test commands (echo, sh, etc.) - pipe directly
        child.stdout.pipe(logStream, { end: false });
      } else {
        // For claude with stream-json - parse events and extract text
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const text = extractTextFromStreamJson(trimmed);
            if (text) {
              logStream.write(text);
            }
            for (const name of countToolUseInStreamEvent(trimmed)) {
              toolCalls += 1;
              toolsByName[name] = (toolsByName[name] ?? 0) + 1;
            }
          }
        });
      }

      child.stderr.pipe(logStream, { end: false });

      let isTimedOut = false;
      let processExited = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        isTimedOut = true;
        child.kill("SIGTERM");
        // `child.killed` only reflects that a signal was *sent*, not that the
        // process died. A child that ignores SIGTERM (e.g. a hung `claude -p`)
        // would otherwise never be escalated to SIGKILL. Track real exit instead.
        sigkillTimer = setTimeout(() => {
          if (!processExited) child.kill("SIGKILL");
        }, sigkillGraceMs);
      }, timeout * 1000);

      child.on("close", (code) => {
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
    result = await runAttempt();
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

  const finalStatus: RunStatusFile = {
    status: result.status,
    exitCode: result.exitCode,
    startedAt: meta.startedAt,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    getStatusPath(projectRoot, jobId, runId),
    JSON.stringify(finalStatus, null, 2),
  );
  writeStats();

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
