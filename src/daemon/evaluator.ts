import { spawn } from "child_process";
import fs from "fs";
import type { RunEvaluation, RunStatus } from "@shared/types";
import { getLogPath, getEvalPath } from "@shared/paths";
import { CostTracker, writeEvaluationCost } from "./costs";

const EVAL_PROMPT = `You are evaluating the output of a scheduled AI job run. Analyze the output and respond with ONLY a JSON object (no markdown, no code fences, no explanation) in this exact format:

{
  "summary": "1-2 sentence summary of what happened",
  "severity": "ok|info|warning|critical",
  "followUpNeeded": true|false,
  "followUpReason": "why follow-up is needed, or null"
}

Severity guide:
- "ok": completed successfully, no issues
- "info": completed with minor notes worth knowing
- "warning": completed but with issues that should be addressed soon (partial failures, degraded data, auth warnings)
- "critical": failed, produced wrong results, or has errors requiring immediate attention (auth expired, data corruption, missing outputs)

Set followUpNeeded=true if a human should look at this before the next scheduled run. Common triggers:
- Auth/credential failures
- Partial completions where some steps failed
- Unexpected errors or warnings in output
- Missing expected output files
- Any request in the output asking for human input

Job name: {{JOB_NAME}}
Job status: {{JOB_STATUS}}
Exit code: {{EXIT_CODE}}

Output log (last 200 lines):
{{OUTPUT}}`;

function buildEvalPrompt(jobName: string, status: RunStatus, exitCode: number | null, output: string): string {
  const lines = output.split("\n");
  const tail = lines.length > 200 ? lines.slice(-200).join("\n") : output;

  return EVAL_PROMPT
    .replace("{{JOB_NAME}}", jobName)
    .replace("{{JOB_STATUS}}", status)
    .replace("{{EXIT_CODE}}", String(exitCode ?? "N/A"))
    .replace("{{OUTPUT}}", tail);
}

function parseEvalResponse(raw: string): RunEvaluation | null {
  try {
    // Strip markdown fences if model adds them despite instructions
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const severity = ["ok", "info", "warning", "critical"].includes(parsed.severity)
      ? parsed.severity
      : "info";

    return {
      summary: String(parsed.summary ?? "No summary"),
      severity,
      followUpNeeded: Boolean(parsed.followUpNeeded),
      followUpReason: parsed.followUpReason ? String(parsed.followUpReason) : null,
      evaluatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function evaluateRun(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
): Promise<RunEvaluation | null> {
  const logPath = getLogPath(projectRoot, jobId, runId);

  let output = "";
  try {
    output = fs.readFileSync(logPath, "utf-8");
  } catch {
    output = "(no output captured)";
  }

  if (!output.trim()) {
    output = "(empty output)";
  }

  const prompt = buildEvalPrompt(jobName, status, exitCode, output);
  writeEvaluationCost(projectRoot, jobId, runId, "pending");

  return new Promise<RunEvaluation | null>((resolve) => {
    const child = spawn("claude", ["-p", "--model", "haiku", "--output-format", "json", "--no-session-persistence", prompt], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 60_000);

    child.on("close", () => {
      clearTimeout(timer);

      const tracker = new CostTracker("claude", 1);
      tracker.consume(stdout);
      const snapshot = tracker.snapshot();
      writeEvaluationCost(projectRoot, jobId, runId, snapshot.complete ? "complete" : "unavailable", snapshot.entries[0] ?? null);
      let evaluation: RunEvaluation | null = null;
      try {
        const result: unknown = JSON.parse(stdout);
        if (result && typeof result === "object" && "type" in result && result.type === "result" && "result" in result && typeof result.result === "string") {
          evaluation = parseEvalResponse(result.result);
        }
      } catch {
        evaluation = null;
      }
      if (evaluation) {
        const evalPath = getEvalPath(projectRoot, jobId, runId);
        fs.writeFileSync(evalPath, JSON.stringify(evaluation, null, 2));
        console.log(`[eval] ${jobId}: severity=${evaluation.severity}, followUp=${evaluation.followUpNeeded}`);
      } else {
        console.warn(`[eval] ${jobId}: failed to parse evaluation response`);
      }

      resolve(evaluation);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[eval] ${jobId}: process error: ${err.message}`);
      writeEvaluationCost(projectRoot, jobId, runId, "unavailable");
      resolve(null);
    });
  });
}
