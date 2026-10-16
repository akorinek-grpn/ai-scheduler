import { spawn } from "child_process";
import fs from "fs";
import type {
  DecisionMode,
  EvalSeverity,
  RunDecision,
  RunEvaluation,
  RunStatus,
  UsageLimitHit,
} from "@shared/types";
import { getLogPath, getEvalPath } from "@shared/paths";
import {
  CostTracker,
  readRunDecision,
  writeEvaluationCost,
  writeRunDecision,
} from "./costs";
import {
  appendEvaluationRecord,
  buildEvaluationRecord,
} from "./evaluation-log";
import { readRunSummary } from "./run-history";
import {
  requestRunDecision,
  type DecisionClientOptions,
  type DecisionInput,
  type DecisionResult,
} from "./decision";

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

export interface EvaluateOptions {
  /** scheduler.yaml `evaluator.decision_model`; "off" when unset. */
  decisionMode?: DecisionMode;
  /** Overrides for the Jev client (tests inject fetch and a key here). */
  decision?: DecisionClientOptions;
  /** scheduler.yaml `evaluator.log_retain_months`; 12 when unset. */
  logRetainMonths?: number;
}

function buildEvalPrompt(
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
  output: string,
): string {
  const lines = output.split("\n");
  const tail = lines.length > 200 ? lines.slice(-200).join("\n") : output;

  return EVAL_PROMPT.replace("{{JOB_NAME}}", jobName)
    .replace("{{JOB_STATUS}}", status)
    .replace("{{EXIT_CODE}}", String(exitCode ?? "N/A"))
    .replace("{{OUTPUT}}", tail);
}

function parseEvalResponse(raw: string): RunEvaluation | null {
  try {
    // Strip markdown fences if model adds them despite instructions
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    const severity = ["ok", "info", "warning", "critical"].includes(
      parsed.severity,
    )
      ? parsed.severity
      : "info";

    return {
      summary: String(parsed.summary ?? "No summary"),
      severity,
      followUpNeeded: Boolean(parsed.followUpNeeded),
      followUpReason: parsed.followUpReason
        ? String(parsed.followUpReason)
        : null,
      evaluatedAt: new Date().toISOString(),
      source: "haiku",
    };
  } catch {
    return null;
  }
}

function readOutput(projectRoot: string, jobId: string, runId: string): string {
  let output = "";
  try {
    output = fs.readFileSync(getLogPath(projectRoot, jobId, runId), "utf-8");
  } catch {
    output = "(no output captured)";
  }
  return output.trim() ? output : "(empty output)";
}

/** Model alias for the prose summary of a flagged run (cheap; the verdict is Jev's). */
const SUMMARY_MODEL = "haiku";
/**
 * Model alias for the second opinion inside SECOND_OPINION_BAND. Sonnet since 2026-10-16: the
 * 2026-10-15 replay found Haiku's band verdicts were mostly flags on runs that stood down on
 * purpose, and with the Air on its own account the better judge costs nothing that matters.
 */
export const SECOND_OPINION_MODEL = "sonnet";

/** `claude -p --model <model>` over the prompt; tracks its own cost in evaluation-cost.json. Does not persist the evaluation. */
function runClaude(
  projectRoot: string,
  jobId: string,
  runId: string,
  prompt: string,
  model: string,
): Promise<RunEvaluation | null> {
  writeEvaluationCost(projectRoot, jobId, runId, "pending");

  return new Promise<RunEvaluation | null>((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--no-session-persistence",
        prompt,
      ],
      {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
      writeEvaluationCost(
        projectRoot,
        jobId,
        runId,
        snapshot.complete ? "complete" : "unavailable",
        snapshot.entries[0] ?? null,
      );
      let evaluation: RunEvaluation | null = null;
      try {
        const result: unknown = JSON.parse(stdout);
        if (
          result &&
          typeof result === "object" &&
          "type" in result &&
          result.type === "result" &&
          "result" in result &&
          typeof result.result === "string"
        ) {
          evaluation = parseEvalResponse(result.result);
        }
      } catch {
        evaluation = null;
      }
      if (!evaluation)
        console.warn(`[eval] ${jobId}: failed to parse evaluation response`);
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

const percent = (value: number): string => value.toFixed(2);

/**
 * Jev's P(follow-up) is close to a coin flip in this band, a margin around FOLLOW_UP_THRESHOLD.
 * In enforce mode Haiku gives a second opinion there, and the evaluation keeps the more severe
 * label and a follow-up asked for by either model: a missed follow-up costs more than a needless
 * one. 0.40-0.60 until 2026-10-15; narrowed with the threshold move to 0.6 because the 2026-10-15
 * log review found Haiku's band verdicts were mostly flags on runs that stood down on purpose
 * (lock held, nothing eligible), none with hard evidence, so a wide band imported Haiku's noise.
 */
export const SECOND_OPINION_BAND = { min: 0.55, max: 0.65 } as const;

const SEVERITY_ORDER: readonly EvalSeverity[] = [
  "ok",
  "info",
  "warning",
  "critical",
];
const moreSevere = (left: EvalSeverity, right: EvalSeverity): EvalSeverity =>
  SEVERITY_ORDER.indexOf(right) > SEVERITY_ORDER.indexOf(left) ? right : left;

/** Jev call wrapped in the pending -> complete/unavailable lifecycle of evaluation-decision.json. */
async function runDecision(
  projectRoot: string,
  jobId: string,
  runId: string,
  mode: Exclude<DecisionMode, "off">,
  input: DecisionInput,
  options: DecisionClientOptions | undefined,
): Promise<DecisionResult> {
  writeRunDecision(projectRoot, jobId, runId, {
    version: 1,
    mode,
    state: "pending",
    decision: null,
    usage: null,
    error: null,
    updatedAt: new Date().toISOString(),
  });
  const result = await requestRunDecision(input, options);
  writeRunDecision(projectRoot, jobId, runId, {
    version: 1,
    mode,
    state: result.decision ? "complete" : "unavailable",
    decision: result.decision,
    usage: result.usage,
    error: result.error,
    updatedAt: new Date().toISOString(),
  });
  const decision = result.decision;
  if (decision) {
    console.log(
      `[eval] ${jobId}: jev severity=${decision.severity.label} (p=${percent(decision.severity.probabilities[decision.severity.label])}) ` +
        `followUp=${decision.followUp.needed} (p=${percent(decision.followUp.probability)}) failure=${decision.failureKind.choice} ` +
        `${decision.latencyMs}ms${mode === "shadow" ? " (shadow)" : ""}`,
    );
  } else {
    console.warn(`[eval] ${jobId}: jev decision unavailable: ${result.error}`);
  }
  return result;
}

/** Prose for runs Jev judged clean, so Haiku is not spent on them. */
function describeRun(
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
  decision: RunDecision,
): string {
  const { severity, followUp, failureKind } = decision;
  return (
    `${jobName} completed with status ${status} (exit code ${exitCode ?? "N/A"}). ` +
    `Jev: severity ${severity.label} (p=${percent(severity.probabilities[severity.label])}), ` +
    `follow-up ${followUp.needed ? "needed" : "not needed"} (p=${percent(followUp.probability)}), ` +
    `dominant issue ${failureKind.choice}.`
  );
}

function persist(
  projectRoot: string,
  jobId: string,
  runId: string,
  evaluation: RunEvaluation | null,
): RunEvaluation | null {
  if (evaluation) {
    fs.writeFileSync(
      getEvalPath(projectRoot, jobId, runId),
      JSON.stringify(evaluation, null, 2),
    );
    console.log(
      `[eval] ${jobId}: severity=${evaluation.severity}, followUp=${evaluation.followUpNeeded}${evaluation.source ? ` (${evaluation.source})` : ""}`,
    );
  }
  return evaluation;
}

async function evaluateRunInner(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
  options: EvaluateOptions = {},
): Promise<RunEvaluation | null> {
  const mode = options.decisionMode ?? "off";
  const output = readOutput(projectRoot, jobId, runId);
  const prompt = buildEvalPrompt(jobName, status, exitCode, output);
  const haiku = (model: string = SUMMARY_MODEL): Promise<RunEvaluation | null> =>
    runClaude(projectRoot, jobId, runId, prompt, model);
  const input: DecisionInput = { jobName, status, exitCode, output };

  if (mode === "off") return persist(projectRoot, jobId, runId, await haiku());

  if (mode === "shadow") {
    const [evaluation] = await Promise.all([
      haiku(),
      runDecision(projectRoot, jobId, runId, mode, input, options.decision),
    ]);
    return persist(projectRoot, jobId, runId, evaluation);
  }

  if (mode === "benchmark") {
    // Jev decides exactly as in enforce; Haiku judges every run in parallel, so its verdict is a
    // standing baseline to measure Jev against. Haiku decides only when Jev is unavailable.
    const [haikuVerdict, result] = await Promise.all([
      haiku(),
      runDecision(projectRoot, jobId, runId, mode, input, options.decision),
    ]);
    if (!result.decision)
      return persist(projectRoot, jobId, runId, haikuVerdict);
    return persist(
      projectRoot,
      jobId,
      runId,
      jevEvaluation(
        jobId,
        jobName,
        status,
        exitCode,
        result.decision,
        haikuVerdict,
        true,
      ),
    );
  }

  // enforce: Jev decides; Haiku writes the summary when there is something to explain, and gives a
  // second opinion when Jev is unsure whether the run needs a follow-up.
  const result = await runDecision(
    projectRoot,
    jobId,
    runId,
    mode,
    input,
    options.decision,
  );
  const decision = result.decision;
  if (!decision) return persist(projectRoot, jobId, runId, await haiku());

  // One call serves both purposes: in the uncertain band the second-opinion model also writes
  // the summary; outside it the summary model explains a warning, critical or follow-up run.
  let haikuVerdict: RunEvaluation | null = null;
  if (inSecondOpinionBand(decision.followUp.probability))
    haikuVerdict = await haiku(SECOND_OPINION_MODEL);
  else if (needsHaiku(decision)) haikuVerdict = await haiku();
  // Otherwise the evaluation is complete without a Haiku call; there is no Haiku cost to report.
  else writeEvaluationCost(projectRoot, jobId, runId, "complete", null);
  return persist(
    projectRoot,
    jobId,
    runId,
    jevEvaluation(
      jobId,
      jobName,
      status,
      exitCode,
      decision,
      haikuVerdict,
      false,
    ),
  );
}

const inSecondOpinionBand = (probability: number): boolean =>
  probability >= SECOND_OPINION_BAND.min &&
  probability <= SECOND_OPINION_BAND.max;

/** Enforce asks Haiku when there is something to explain, or when Jev is unsure about the follow-up. */
function needsHaiku(decision: RunDecision): boolean {
  return (
    decision.severity.label === "warning" ||
    decision.severity.label === "critical" ||
    decision.followUp.needed ||
    inSecondOpinionBand(decision.followUp.probability)
  );
}

/**
 * Jev's verdict as the evaluation: Haiku's summary when Haiku ran, Haiku's second opinion inside the
 * uncertain band, and in benchmark mode Haiku's own verdict recorded beside it (never applied).
 */
function jevEvaluation(
  jobId: string,
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
  decision: RunDecision,
  haikuVerdict: RunEvaluation | null,
  benchmark: boolean,
): RunEvaluation {
  const { failureKind, followUp } = decision;
  let severity = decision.severity.label;
  let followUpNeeded = followUp.needed;
  let followUpReason = followUp.needed
    ? `Jev: failure_kind=${failureKind.choice} (p=${percent(failureKind.probabilities[failureKind.choice] ?? 0)}); P(follow-up)=${percent(followUp.probability)}`
    : null;
  let secondOpinion: RunEvaluation["secondOpinion"];
  if (haikuVerdict && inSecondOpinionBand(followUp.probability)) {
    secondOpinion = {
      severity: haikuVerdict.severity,
      followUpNeeded: haikuVerdict.followUpNeeded,
    };
    const opinionModel = benchmark ? SUMMARY_MODEL : SECOND_OPINION_MODEL;
    console.log(
      `[eval] ${jobId}: ${opinionModel} second opinion severity=${haikuVerdict.severity} followUp=${haikuVerdict.followUpNeeded} (jev P(follow-up)=${percent(followUp.probability)})`,
    );
    severity = moreSevere(severity, haikuVerdict.severity);
    if (haikuVerdict.followUpNeeded && !followUpNeeded) {
      followUpNeeded = true;
      followUpReason = `${opinionModel === SUMMARY_MODEL ? "Haiku" : "Sonnet"} second opinion (Jev P(follow-up)=${percent(followUp.probability)} is in the uncertain band): ${haikuVerdict.followUpReason ?? haikuVerdict.summary}`;
    }
  }
  const haikuBenchmark =
    benchmark && haikuVerdict
      ? {
          severity: haikuVerdict.severity,
          followUpNeeded: haikuVerdict.followUpNeeded,
        }
      : undefined;
  if (haikuBenchmark)
    console.log(
      `[eval] ${jobId}: haiku benchmark severity=${haikuBenchmark.severity} followUp=${haikuBenchmark.followUpNeeded}`,
    );
  return {
    summary:
      haikuVerdict?.summary ?? describeRun(jobName, status, exitCode, decision),
    severity,
    followUpNeeded,
    followUpReason,
    evaluatedAt: new Date().toISOString(),
    source: haikuVerdict ? "jev+haiku" : "jev",
    ...(secondOpinion ? { secondOpinion } : {}),
    ...(haikuBenchmark ? { haikuBenchmark } : {}),
  };
}

/** Appends the run's ledger line; never fails the evaluation. */
function recordEvaluation(
  projectRoot: string,
  jobId: string,
  runId: string,
  retainMonths: number | undefined,
): void {
  try {
    const summary = readRunSummary(projectRoot, jobId, runId);
    if (!summary) return;
    appendEvaluationRecord(
      projectRoot,
      buildEvaluationRecord(
        summary,
        readRunDecision(projectRoot, jobId, runId),
      ),
      retainMonths ?? 12,
    );
  } catch (error) {
    console.warn(
      `[eval] ${jobId}: could not append the evaluation ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A run deferred by its precondition (exit 75) ran nothing: the scheduler rates it ok itself,
 * without a Haiku or Jev call, and still writes the ledger line so the slot's history is whole.
 * The summary carries the precondition's last line (what held the run back).
 */
export function evaluateDeferredRun(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
  options: Pick<EvaluateOptions, "logRetainMonths"> = {},
): RunEvaluation {
  const output = readOutput(projectRoot, jobId, runId);
  const reason =
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("==="))
      .at(-1) ?? "precondition exit 75";
  const evaluation: RunEvaluation = {
    summary: `${jobName} deferred by its precondition: ${reason}`,
    severity: "ok",
    followUpNeeded: false,
    followUpReason: null,
    evaluatedAt: new Date().toISOString(),
    source: "scheduler",
  };
  writeEvaluationCost(projectRoot, jobId, runId, "complete", null);
  persist(projectRoot, jobId, runId, evaluation);
  recordEvaluation(projectRoot, jobId, runId, options.logRetainMonths);
  return evaluation;
}

/**
 * A run `blocked` by the account's usage limit (2026-10-16): the limit line is the whole
 * story, so no model reads the log. Warning, no follow-up (the hold is the response, and the
 * dashboard banner the notice), source `scheduler`, one ledger line like any other run.
 */
export function evaluateUsageLimitedRun(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
  hit: UsageLimitHit,
  heldUntil: string | null,
  options: Pick<EvaluateOptions, "logRetainMonths"> = {},
): RunEvaluation {
  const evaluation: RunEvaluation = {
    summary:
      `${jobName} stopped: the Claude account's ${hit.kind} usage limit is exhausted ("${hit.text}"). ` +
      (heldUntil
        ? `Jobs that start a Claude session on this Mac are held until ${heldUntil}.`
        : "Jobs that start a Claude session on this Mac are held."),
    severity: "warning",
    followUpNeeded: false,
    followUpReason: null,
    evaluatedAt: new Date().toISOString(),
    source: "scheduler",
  };
  writeEvaluationCost(projectRoot, jobId, runId, "complete", null);
  persist(projectRoot, jobId, runId, evaluation);
  recordEvaluation(projectRoot, jobId, runId, options.logRetainMonths);
  return evaluation;
}

export async function evaluateRun(
  projectRoot: string,
  jobId: string,
  runId: string,
  jobName: string,
  status: RunStatus,
  exitCode: number | null,
  options: EvaluateOptions = {},
): Promise<RunEvaluation | null> {
  const evaluation = await evaluateRunInner(
    projectRoot,
    jobId,
    runId,
    jobName,
    status,
    exitCode,
    options,
  );
  recordEvaluation(projectRoot, jobId, runId, options.logRetainMonths);
  return evaluation;
}
