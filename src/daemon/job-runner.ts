import { spawn } from "child_process";
import fs from "fs";
import crypto from "crypto";
import type { JobConfig, TriggerType, RunMeta, RunStatusFile } from "@shared/types";
import {
  getRunDir,
  getLogPath,
  getStatusPath,
  getMetaPath,
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
}

interface RunResult {
  runId: string;
  status: "success" | "failed" | "timeout";
  exitCode: number | null;
}

function generateRunId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${hash}`;
}

function extractTextFromStreamJson(line: string): string | null {
  try {
    const event = JSON.parse(line);

    // Assistant message text content
    if (event.type === "assistant" && event.message?.content) {
      const texts = event.message.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text);
      if (texts.length > 0) return texts.join("");
    }

    // Content block delta (streaming partial text)
    if (event.type === "content_block_delta" && event.delta?.text) {
      return event.delta.text;
    }

    // Result message at the end
    if (event.type === "result" && event.result?.trim()) {
      return event.result;
    }

    // Tool use — log what tool is being called
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          return `[tool: ${block.name}]\n`;
        }
      }
    }

    // Tool result — log output
    if (event.type === "tool_result" && event.content) {
      const text = typeof event.content === "string"
        ? event.content
        : Array.isArray(event.content)
          ? event.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("")
          : "";
      if (text) return `${text}\n`;
    }
  } catch {
    // Not valid JSON — could be partial line, ignore
  }
  return null;
}

export async function runJob(options: RunJobOptions): Promise<RunResult> {
  const { jobId, jobConfig, projectRoot, trigger, defaultTimeout = 300 } = options;
  const runId = generateRunId();
  const runDir = getRunDir(projectRoot, jobId, runId);

  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobId,
    runId,
    jobConfig,
    trigger,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getMetaPath(projectRoot, jobId, runId), JSON.stringify(meta, null, 2));

  const statusFile: RunStatusFile = {
    status: "running",
    exitCode: null,
    startedAt: meta.startedAt,
    finishedAt: null,
  };
  fs.writeFileSync(getStatusPath(projectRoot, jobId, runId), JSON.stringify(statusFile, null, 2));

  const logPath = getLogPath(projectRoot, jobId, runId);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const command = options.command ?? "claude";
  const isCustomCommand = options.command !== undefined || options.args !== undefined;

  const args =
    options.args ??
    [
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      ...(jobConfig.skip_permissions ? ["--dangerously-skip-permissions"] : []),
      ...(jobConfig.model ? ["--model", jobConfig.model] : []),
      jobConfig.prompt,
    ];

  const timeout = jobConfig.timeout ?? defaultTimeout;

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: jobConfig.directory,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (isCustomCommand) {
      // For test commands (echo, sh, etc.) — pipe directly
      child.stdout.pipe(logStream);
    } else {
      // For claude with stream-json — parse events and extract text
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
        }
      });
    }

    child.stderr.pipe(logStream);

    let isTimedOut = false;
    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, timeout * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      logStream.end();

      const finalStatus: RunStatusFile = {
        status: isTimedOut ? "timeout" : code === 0 ? "success" : "failed",
        exitCode: code,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        getStatusPath(projectRoot, jobId, runId),
        JSON.stringify(finalStatus, null, 2),
      );

      const symlinkPath = getLatestSymlink(projectRoot, jobId);
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        // symlink doesn't exist yet
      }
      fs.symlinkSync(runId, symlinkPath);

      resolve({
        runId,
        status: finalStatus.status as RunResult["status"],
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      logStream.write(`\nProcess error: ${err.message}\n`);
      logStream.end();

      const finalStatus: RunStatusFile = {
        status: "failed",
        exitCode: null,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        getStatusPath(projectRoot, jobId, runId),
        JSON.stringify(finalStatus, null, 2),
      );

      const symPath = getLatestSymlink(projectRoot, jobId);
      try {
        fs.unlinkSync(symPath);
      } catch {
        // noop
      }
      fs.symlinkSync(runId, symPath);

      resolve({ runId, status: "failed", exitCode: null });
    });
  });
}
