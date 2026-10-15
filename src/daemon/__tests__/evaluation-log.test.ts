import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvaluationRecord,
  buildEvaluationRecord,
  getEvaluationLogPath,
  readEvaluationRecords,
} from "../evaluation-log";
import type { RunDecisionFile, RunSummary } from "@shared/types";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-eval-log-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  jobId: "job",
  runId: "2026-10-01T09-30-07-bd4660",
  jobName: "Job",
  directory: "/tmp",
  status: "success",
  trigger: "scheduled",
  startedAt: "2026-10-01T09:30:07.000Z",
  finishedAt: "2026-10-01T09:30:20.000Z",
  exitCode: 0,
  evaluation: {
    summary: "fine",
    severity: "ok",
    followUpNeeded: false,
    followUpReason: null,
    evaluatedAt: "2026-10-01T09:31:00Z",
    source: "haiku",
  },
  cost: {
    currency: "USD",
    totalCostUsd: 0.08003,
    executionCostUsd: null,
    evaluationCostUsd: 0.08,
    decisionCostUsd: 0.00003,
    coverage: "partial",
    evaluationState: "complete",
    decisionState: "complete",
    attempts: [],
    evaluation: {
      id: "claude",
      label: "Claude session",
      source: "claude",
      costUsd: 0.08,
      tokens: null,
      models: [
        {
          model: "claude-haiku-4-5",
          costUsd: 0.08,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    },
    decision: {
      requests: 1,
      inputTokens: 755,
      outputTokens: 112,
      costUsd: 0.00003,
      model: "typesafe/jev-1.13-20260917",
    },
    tokens: null,
  },
  ...overrides,
});

const decisionFile = (
  severity: "ok" | "warning",
  followUp: number,
): RunDecisionFile => ({
  version: 1,
  mode: "shadow",
  state: "complete",
  error: null,
  updatedAt: "2026-10-01T09:31:00Z",
  usage: {
    requests: 1,
    inputTokens: 755,
    outputTokens: 112,
    costUsd: 0.00003,
    model: "typesafe/jev-1.13-20260917",
  },
  decision: {
    model: "typesafe/jev-1.13-20260917",
    requestId: "gen-1",
    provider: "TypeSafe",
    latencyMs: 491,
    severity: {
      label: severity,
      score: 0.2,
      confidence: 0.9,
      probabilities: {
        ok: severity === "ok" ? 0.9 : 0.1,
        info: 0.05,
        warning: severity === "ok" ? 0.05 : 0.85,
        critical: 0,
      },
    },
    followUp: { probability: followUp, needed: followUp >= 0.5 },
    failureKind: {
      choice: "none",
      confidence: 0.8,
      probabilities: { none: 0.9, other: 0.1 },
    },
    evaluatedAt: "2026-10-01T09:30:21Z",
  },
});

describe("evaluation ledger", () => {
  it("builds one flat record per run with run facts, both verdicts, costs, latency and agreement", () => {
    const record = buildEvaluationRecord(
      run(),
      decisionFile("ok", 0.13),
      "2026-10-01T09:31:00Z",
    );
    expect(record).toMatchObject({
      version: 1,
      ts: "2026-10-01T09:31:00Z",
      jobId: "job",
      runId: "2026-10-01T09-30-07-bd4660",
      jobName: "Job",
      trigger: "scheduled",
      status: "success",
      exitCode: 0,
      durationMs: 13000,
      attempts: 0,
      executionCostUsd: null,
      executionModels: [],
      evaluation: {
        source: "haiku",
        severity: "ok",
        followUpNeeded: false,
        haikuCostUsd: 0.08,
        haikuModel: "claude-haiku-4-5",
      },
      decision: {
        mode: "shadow",
        state: "complete",
        model: "typesafe/jev-1.13-20260917",
        severity: "ok",
        severityConfidence: 0.9,
        followUpProbability: 0.13,
        failureKind: "none",
        latencyMs: 491,
        inputTokens: 755,
        costUsd: 0.00003,
        error: null,
      },
      agreement: { severity: true, followUp: true },
    });
    expect(record.decision.severityProbabilities).toEqual({
      ok: 0.9,
      info: 0.05,
      warning: 0.05,
      critical: 0,
    });
  });

  it("records disagreement, and leaves agreement unknown when one side did not run", () => {
    const disagree = buildEvaluationRecord(
      run(),
      decisionFile("warning", 0.86),
      "2026-10-01T09:31:00Z",
    );
    expect(disagree.agreement).toEqual({ severity: false, followUp: false });
    const haikuOnly = buildEvaluationRecord(
      run({
        cost: {
          ...run().cost!,
          decisionState: "off",
          decision: null,
          decisionCostUsd: null,
        },
      }),
      null,
      "2026-10-01T09:31:00Z",
    );
    expect(haikuOnly.decision).toMatchObject({
      mode: "off",
      state: "off",
      severity: null,
      costUsd: null,
    });
    expect(haikuOnly.agreement).toEqual({ severity: null, followUp: null });
    const jevOnly = buildEvaluationRecord(
      run({
        evaluation: { ...run().evaluation!, source: "jev" },
        cost: { ...run().cost!, evaluation: null, evaluationCostUsd: null },
      }),
      { ...decisionFile("ok", 0.1), mode: "enforce" },
      "2026-10-01T09:31:00Z",
    );
    expect(jevOnly.evaluation).toMatchObject({
      source: "jev",
      haikuCostUsd: null,
      haikuModel: null,
    });
    expect(jevOnly.agreement).toEqual({ severity: null, followUp: null });
  });

  it("appends to a monthly JSONL file and prunes months beyond the retention window", () => {
    const record = buildEvaluationRecord(
      run(),
      decisionFile("ok", 0.13),
      "2026-10-01T09:31:00Z",
    );
    appendEvaluationRecord(root, record, 3);
    appendEvaluationRecord(
      root,
      { ...record, runId: "second", ts: "2026-10-02T09:31:00Z" },
      3,
    );
    const file = getEvaluationLogPath(root, "2026-10-01T09:31:00Z");
    expect(
      file.endsWith(path.join("data", "evaluations", "2026-10.jsonl")),
    ).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ runId: "second" });
    const dir = path.dirname(file);
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"])
      fs.writeFileSync(path.join(dir, `${month}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    appendEvaluationRecord(
      root,
      { ...record, runId: "third", ts: "2026-10-03T09:31:00Z" },
      3,
    );
    expect(fs.readdirSync(dir).sort()).toEqual([
      "2026-08.jsonl",
      "2026-09.jsonl",
      "2026-10.jsonl",
      "notes.txt",
    ]);
  });

  it("reads records back across months in time order, skipping corrupt lines", () => {
    const record = buildEvaluationRecord(
      run(),
      decisionFile("ok", 0.13),
      "2026-09-30T09:31:00Z",
    );
    appendEvaluationRecord(root, record, 12);
    appendEvaluationRecord(
      root,
      { ...record, runId: "oct", ts: "2026-10-01T09:31:00Z" },
      12,
    );
    fs.appendFileSync(
      getEvaluationLogPath(root, "2026-10-01T09:31:00Z"),
      "{not json\n",
    );
    const records = readEvaluationRecords(root, {
      since: "2026-09-01T00:00:00Z",
    });
    expect(records.map((entry) => entry.runId)).toEqual([
      "2026-10-01T09-30-07-bd4660",
      "oct",
    ]);
    expect(
      readEvaluationRecords(root, { since: "2026-10-01T00:00:00Z" }).map(
        (entry) => entry.runId,
      ),
    ).toEqual(["oct"]);
    expect(readEvaluationRecords(path.join(root, "nowhere"))).toEqual([]);
  });
});
