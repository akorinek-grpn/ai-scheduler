import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRun } from "../evaluator";
import { readRunCost, readRunDecision } from "../costs";
import { getEvalPath, getLogPath, getRunDir } from "@shared/paths";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-evaluator-"));
  fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
  fs.writeFileSync(
    getLogPath(root, "job", "run"),
    "=== Step ===\nPreflight exited 2: host unreachable\n=== Done ===\n",
  );
  fs.writeFileSync(
    path.join(getRunDir(root, "job", "run"), "meta.json"),
    JSON.stringify({
      jobId: "job",
      runId: "run",
      jobConfig: {
        name: "Job",
        directory: root,
        type: "script",
        command: "true",
        enabled: true,
        tags: [],
      },
      trigger: "manual",
      startedAt: "2026-10-01T09:30:07.000Z",
    }),
  );
  fs.writeFileSync(
    path.join(getRunDir(root, "job", "run"), "status.json"),
    JSON.stringify({
      status: "success",
      exitCode: 0,
      startedAt: "2026-10-01T09:30:07.000Z",
      finishedAt: "2026-10-01T09:30:20.000Z",
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fake `claude` on PATH that records each invocation and answers like Haiku. */
function fakeHaiku(answer: unknown): string {
  const bin = path.join(root, "bin");
  const calls = path.join(root, "haiku-calls");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
    require("node:fs").appendFileSync(${JSON.stringify(calls)}, "call\\n");
    process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0.08,result:${JSON.stringify(JSON.stringify(answer))}}));
  `,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return calls;
}
const haikuCalls = (file: string): number =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length
    : 0;

const jevReply = (
  severity: Record<string, number>,
  followUp: number,
  failure = "none",
): Response =>
  new Response(
    JSON.stringify({
      id: "gen-1",
      provider: "TypeSafe",
      model: "typesafe/jev-1.13-20260917",
      answers: {
        severity: {
          type: "score",
          score: 1,
          confidence: 0.6,
          probabilities: severity,
        },
        follow_up_needed: { type: "noul", noul: followUp },
        failure_kind: {
          type: "choice",
          choice: failure,
          confidence: 0.4,
          probabilities: { [failure]: 0.5, other: 0.5 },
        },
      },
      usage: { input_tokens: 800, output_tokens: 90, cost: 0.0000336 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const decision = (fetchMock: unknown) => ({
  apiKey: "k",
  baseUrl: "https://openrouter.ai/api",
  model: "typesafe/jev-1.13",
  fetch: fetchMock as typeof fetch,
  retryDelayMs: 0,
});
const readEvaluation = () =>
  JSON.parse(fs.readFileSync(getEvalPath(root, "job", "run"), "utf8"));

describe("evaluator decision modes", () => {
  it("off: evaluates with Haiku only and writes no decision file", async () => {
    const calls = fakeHaiku({
      summary: "Haiku summary",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn();
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      { decisionMode: "off", decision: decision(fetchMock) },
    );
    expect(evaluation).toMatchObject({
      summary: "Haiku summary",
      severity: "ok",
      source: "haiku",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(haikuCalls(calls)).toBe(1);
    expect(readRunDecision(root, "job", "run")).toBeNull();
    expect(readRunCost(root, "job", "run").decisionState).toBe("off");
  });

  it("shadow: records the Jev decision and its usage while evaluation.json still comes from Haiku", async () => {
    fakeHaiku({
      summary: "Haiku summary",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.1, "1": 0.5, "2": 0.4, "3": 0 }, 0.71, "network"),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      { decisionMode: "shadow", decision: decision(fetchMock) },
    );
    expect(evaluation).toMatchObject({
      severity: "ok",
      followUpNeeded: false,
      source: "haiku",
    });
    expect(readEvaluation().severity).toBe("ok");
    const file = readRunDecision(root, "job", "run");
    expect(file).toMatchObject({
      mode: "shadow",
      state: "complete",
      usage: { requests: 1, inputTokens: 800, costUsd: 0.0000336 },
    });
    expect(file?.decision).toMatchObject({
      severity: { label: "info" },
      followUp: { probability: 0.71, needed: true },
      failureKind: { choice: "network" },
    });
    expect(readRunCost(root, "job", "run")).toMatchObject({
      decisionCostUsd: 0.0000336,
      decisionState: "complete",
      evaluationCostUsd: 0.08,
    });
  });

  it("enforce: builds the evaluation from Jev and skips Haiku entirely for a clean run", async () => {
    const calls = fakeHaiku({
      summary: "should not be used",
      severity: "critical",
      followUpNeeded: true,
      followUpReason: "x",
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.8, "1": 0.15, "2": 0.05, "3": 0 }, 0.12),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      { decisionMode: "enforce", decision: decision(fetchMock) },
    );
    expect(haikuCalls(calls)).toBe(0);
    expect(evaluation).toMatchObject({
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
      source: "jev",
    });
    expect(evaluation?.summary).toMatch(/ok/);
    expect(evaluation?.summary).toMatch(/exit code 0/);
    expect(readEvaluation()).toMatchObject({ severity: "ok", source: "jev" });
    const cost = readRunCost(root, "job", "run");
    expect(cost).toMatchObject({
      evaluationState: "complete",
      evaluationCostUsd: null,
      decisionCostUsd: 0.0000336,
      totalCostUsd: 0.0000336,
    });
  });

  it("enforce: asks Haiku only for the summary when Jev flags warning or follow-up, keeping Jev's verdict", async () => {
    const calls = fakeHaiku({
      summary: "Haiku explains the host failure",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply(
        { "0": 0.05, "1": 0.1, "2": 0.8, "3": 0.05 },
        0.86,
        "auth_expired",
      ),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "failed",
      1,
      { decisionMode: "enforce", decision: decision(fetchMock) },
    );
    expect(haikuCalls(calls)).toBe(1);
    expect(evaluation).toMatchObject({
      summary: "Haiku explains the host failure",
      severity: "warning",
      followUpNeeded: true,
      source: "jev+haiku",
    });
    expect(evaluation?.followUpReason).toMatch(/auth_expired/);
    expect(readRunCost(root, "job", "run")).toMatchObject({
      evaluationCostUsd: 0.08,
      decisionCostUsd: 0.0000336,
    });
  });

  it("enforce: asks Haiku for a second opinion when Jev's P(follow-up) is in the uncertain band, and a Haiku follow-up wins", async () => {
    const calls = fakeHaiku({
      summary: "Haiku sees an orphaned review",
      severity: "warning",
      followUpNeeded: true,
      followUpReason: "nothing was posted",
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.2, "1": 0.7, "2": 0.1, "3": 0 }, 0.45),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      {
        decisionMode: "enforce",
        decision: decision(fetchMock),
      },
    );
    expect(haikuCalls(calls)).toBe(1);
    expect(evaluation).toMatchObject({
      summary: "Haiku sees an orphaned review",
      severity: "warning",
      followUpNeeded: true,
      source: "jev+haiku",
      secondOpinion: { severity: "warning", followUpNeeded: true },
    });
    expect(evaluation?.followUpReason).toMatch(/second opinion/i);
    expect(evaluation?.followUpReason).toMatch(/nothing was posted/);
    const dir = path.join(root, "data", "evaluations");
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").trim(),
    );
    expect(record.evaluation).toMatchObject({
      source: "jev+haiku",
      followUpNeeded: true,
      secondOpinion: { severity: "warning", followUpNeeded: true },
    });
  });

  it("enforce: keeps Jev's no-follow-up in the band when Haiku agrees, using Haiku's summary", async () => {
    const calls = fakeHaiku({
      summary: "Zero candidates, nothing to do",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.3, "1": 0.6, "2": 0.1, "3": 0 }, 0.48),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      {
        decisionMode: "enforce",
        decision: decision(fetchMock),
      },
    );
    expect(haikuCalls(calls)).toBe(1);
    expect(evaluation).toMatchObject({
      summary: "Zero candidates, nothing to do",
      severity: "info",
      followUpNeeded: false,
      followUpReason: null,
      source: "jev+haiku",
      secondOpinion: { severity: "ok", followUpNeeded: false },
    });
  });

  it("enforce: never lets the second opinion lower Jev's verdict", async () => {
    fakeHaiku({
      summary: "Haiku thinks it was fine",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply(
        { "0": 0.1, "1": 0.2, "2": 0.7, "3": 0 },
        0.56,
        "missing_output",
      ),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      {
        decisionMode: "enforce",
        decision: decision(fetchMock),
      },
    );
    expect(evaluation).toMatchObject({
      severity: "warning",
      followUpNeeded: true,
      secondOpinion: { severity: "ok", followUpNeeded: false },
    });
    expect(evaluation?.followUpReason).toMatch(/missing_output/);
  });

  it("enforce: outside the band there is no second opinion, and Jev's answer stands when Haiku is unavailable in it", async () => {
    const calls = fakeHaiku({
      summary: "unused",
      severity: "critical",
      followUpNeeded: true,
      followUpReason: "x",
    });
    const confident = vi.fn(async () =>
      jevReply({ "0": 0.7, "1": 0.3, "2": 0, "3": 0 }, 0.39),
    );
    const clean = await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "enforce",
      decision: decision(confident),
    });
    expect(haikuCalls(calls)).toBe(0);
    expect(clean).toMatchObject({
      severity: "ok",
      followUpNeeded: false,
      source: "jev",
    });
    expect(clean?.secondOpinion).toBeUndefined();

    vi.stubEnv("PATH", "/nonexistent");
    const uncertain = vi.fn(async () =>
      jevReply({ "0": 0.3, "1": 0.6, "2": 0.1, "3": 0 }, 0.42),
    );
    const fallback = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      {
        decisionMode: "enforce",
        decision: decision(uncertain),
      },
    );
    expect(fallback).toMatchObject({
      severity: "info",
      followUpNeeded: false,
      source: "jev",
    });
    expect(fallback?.secondOpinion).toBeUndefined();
  });

  it("benchmark: Jev decides as in enforce while Haiku judges every run, recorded beside it", async () => {
    const calls = fakeHaiku({
      summary: "Haiku: all clean",
      severity: "info",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.8, "1": 0.15, "2": 0.05, "3": 0 }, 0.12),
    );
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "success",
      0,
      {
        decisionMode: "benchmark",
        decision: decision(fetchMock),
      },
    );
    expect(haikuCalls(calls)).toBe(1);
    expect(evaluation).toMatchObject({
      summary: "Haiku: all clean",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
      source: "jev+haiku",
      haikuBenchmark: { severity: "info", followUpNeeded: false },
    });
    expect(evaluation?.secondOpinion).toBeUndefined();
    expect(readRunDecision(root, "job", "run")).toMatchObject({
      mode: "benchmark",
      state: "complete",
    });
    expect(readRunCost(root, "job", "run")).toMatchObject({
      evaluationCostUsd: 0.08,
      decisionCostUsd: 0.0000336,
    });
    const dir = path.join(root, "data", "evaluations");
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").trim(),
    );
    expect(record).toMatchObject({
      evaluation: {
        source: "jev+haiku",
        severity: "ok",
        haikuBenchmark: { severity: "info", followUpNeeded: false },
      },
      decision: {
        mode: "benchmark",
        severity: "ok",
        followUpProbability: 0.12,
      },
      agreement: { severity: false, followUp: true },
    });
  });

  it("benchmark: Haiku never overrides a confident Jev, but is the second opinion in the uncertain band", async () => {
    fakeHaiku({
      summary: "Haiku alarmed",
      severity: "critical",
      followUpNeeded: true,
      followUpReason: "looks broken",
    });
    const confident = vi.fn(async () =>
      jevReply({ "0": 0.8, "1": 0.15, "2": 0.05, "3": 0 }, 0.1),
    );
    const kept = await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "benchmark",
      decision: decision(confident),
    });
    expect(kept).toMatchObject({
      severity: "ok",
      followUpNeeded: false,
      haikuBenchmark: { severity: "critical", followUpNeeded: true },
    });
    expect(kept?.secondOpinion).toBeUndefined();

    const uncertain = vi.fn(async () =>
      jevReply({ "0": 0.2, "1": 0.7, "2": 0.1, "3": 0 }, 0.45),
    );
    const raised = await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "benchmark",
      decision: decision(uncertain),
    });
    expect(raised).toMatchObject({
      severity: "critical",
      followUpNeeded: true,
      secondOpinion: { severity: "critical", followUpNeeded: true },
      haikuBenchmark: { severity: "critical", followUpNeeded: true },
    });
    expect(raised?.followUpReason).toMatch(/second opinion/i);
  });

  it("benchmark: falls back to Haiku's verdict when Jev is unavailable", async () => {
    fakeHaiku({
      summary: "Haiku fallback",
      severity: "warning",
      followUpNeeded: true,
      followUpReason: "r",
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "failed",
      1,
      {
        decisionMode: "benchmark",
        decision: decision(fetchMock),
      },
    );
    expect(evaluation).toMatchObject({
      summary: "Haiku fallback",
      severity: "warning",
      followUpNeeded: true,
      source: "haiku",
    });
    expect(evaluation?.haikuBenchmark).toBeUndefined();
    expect(readRunDecision(root, "job", "run")).toMatchObject({
      mode: "benchmark",
      state: "unavailable",
    });
  });

  it("enforce: falls back to Haiku when the decision call fails and records why", async () => {
    fakeHaiku({
      summary: "Haiku fallback",
      severity: "warning",
      followUpNeeded: true,
      followUpReason: "r",
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    const evaluation = await evaluateRun(
      root,
      "job",
      "run",
      "Job",
      "failed",
      1,
      { decisionMode: "enforce", decision: decision(fetchMock) },
    );
    expect(evaluation).toMatchObject({
      summary: "Haiku fallback",
      severity: "warning",
      source: "haiku",
    });
    const file = readRunDecision(root, "job", "run");
    expect(file).toMatchObject({
      mode: "enforce",
      state: "unavailable",
      decision: null,
      usage: null,
    });
    expect(file?.error).toContain("500");
    expect(readRunCost(root, "job", "run")).toMatchObject({
      decisionState: "unavailable",
      evaluationCostUsd: 0.08,
    });
  });

  it("appends one ledger line per evaluation with both verdicts and their agreement", async () => {
    fakeHaiku({
      summary: "Haiku summary",
      severity: "ok",
      followUpNeeded: false,
      followUpReason: null,
    });
    const fetchMock = vi.fn(async () =>
      jevReply({ "0": 0.1, "1": 0.5, "2": 0.4, "3": 0 }, 0.71, "network"),
    );
    await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "shadow",
      decision: decision(fetchMock),
      logRetainMonths: 2,
    });
    const dir = path.join(root, "data", "evaluations");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}\.jsonl$/);
    const lines = fs
      .readFileSync(path.join(dir, files[0]), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      version: 1,
      jobId: "job",
      runId: "run",
      trigger: "manual",
      status: "success",
      exitCode: 0,
      durationMs: 13000,
      evaluation: {
        source: "haiku",
        severity: "ok",
        followUpNeeded: false,
        haikuCostUsd: 0.08,
      },
      decision: {
        mode: "shadow",
        state: "complete",
        severity: "info",
        followUpProbability: 0.71,
        failureKind: "network",
        inputTokens: 800,
        costUsd: 0.0000336,
      },
      agreement: { severity: false, followUp: false },
    });
    await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "off",
    });
    expect(
      fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n"),
    ).toHaveLength(2);
  });
});
