import { describe, expect, it } from "vitest";
import {
  analyzeLedger,
  DEFAULT_READINESS,
  formatLedgerReport,
} from "../jev-report";
import type { EvalSeverity, EvaluationLogRecord } from "@shared/types";

type Spec = {
  job?: string;
  run?: string;
  haiku?: EvalSeverity | null;
  haikuFollowUp?: boolean | null;
  haikuCost?: number | null;
  source?: EvaluationLogRecord["evaluation"]["source"];
  jev?: EvalSeverity | null;
  pFollowUp?: number | null;
  jevCost?: number | null;
  latency?: number | null;
  state?: EvaluationLogRecord["decision"]["state"];
  mode?: EvaluationLogRecord["decision"]["mode"];
  secondOpinion?: EvaluationLogRecord["evaluation"]["secondOpinion"];
  haikuBenchmark?: EvaluationLogRecord["evaluation"]["haikuBenchmark"];
};

function record(spec: Spec, index: number): EvaluationLogRecord {
  const {
    job = "job",
    run = `run-${index}`,
    haiku = "ok",
    haikuFollowUp = false,
    haikuCost = 0.08,
    source = "haiku",
    jev = "ok",
    pFollowUp = 0.1,
    jevCost = 0.0003,
    latency = 400,
    state = "complete",
    mode = "shadow",
    secondOpinion,
    haikuBenchmark,
  } = spec;
  return {
    version: 1,
    ts: `2026-10-0${1 + (index % 5)}T10:00:00Z`,
    jobId: job,
    runId: run,
    jobName: job,
    trigger: "scheduled",
    status: "success",
    exitCode: 0,
    startedAt: "2026-10-01T09:00:00Z",
    finishedAt: "2026-10-01T09:01:00Z",
    durationMs: 60000,
    attempts: 1,
    executionCostUsd: 1,
    executionModels: [],
    evaluation: {
      source,
      severity: haiku,
      followUpNeeded: haikuFollowUp,
      haikuCostUsd: haikuCost,
      haikuModel: "claude-haiku-4-5",
      ...(secondOpinion ? { secondOpinion } : {}),
      ...(haikuBenchmark ? { haikuBenchmark } : {}),
    },
    decision: {
      mode,
      state,
      model: "typesafe/jev-1.13-20260917",
      severity: jev,
      severityProbabilities: jev
        ? {
            ok: jev === "ok" ? 0.9 : 0.05,
            info: 0.05,
            warning: jev === "warning" ? 0.9 : 0,
            critical: jev === "critical" ? 0.9 : 0,
          }
        : null,
      severityConfidence: 0.8,
      followUpProbability: pFollowUp,
      failureKind: "none",
      failureKindConfidence: 0.5,
      latencyMs: latency,
      inputTokens: 1000,
      costUsd: jevCost,
      error: null,
    },
    agreement: {
      severity: haiku !== null && jev !== null ? haiku === jev : null,
      followUp:
        haikuFollowUp !== null && pFollowUp !== null
          ? haikuFollowUp === pFollowUp >= 0.5
          : null,
    },
  };
}

describe("Jev enforce-readiness report", () => {
  it("counts compared runs, agreement, the dangerous disagreements, latency and savings", () => {
    const specs: Spec[] = [
      {},
      {},
      {}, // three clean agreements: enforce would skip Haiku -> +0.08 each
      { haiku: "warning", haikuFollowUp: true, jev: "warning", pFollowUp: 0.9 }, // agreed, Haiku would still run
      {
        haiku: "ok",
        haikuFollowUp: false,
        jev: "warning",
        pFollowUp: 0.7,
        job: "other",
      }, // Jev-only follow-up
      {
        haiku: "critical",
        haikuFollowUp: true,
        jev: "ok",
        pFollowUp: 0.2,
        job: "other",
        latency: 900,
      }, // missed critical + Haiku-only follow-up
      { source: "jev", haiku: "ok", haikuFollowUp: false, haikuCost: null }, // enforce-style record, not comparable
      {
        state: "unavailable",
        jev: null,
        pFollowUp: null,
        jevCost: null,
        latency: null,
      }, // Jev failed
    ];
    const report = analyzeLedger(specs.map(record));
    expect(report).toMatchObject({
      evaluated: 8,
      withDecision: 7,
      compared: 6,
      severityAgreed: 4,
      followUpAgreed: 4,
      haikuOnlyFollowUps: 1,
      missedCritical: 1,
      jevOnlyFollowUps: 1,
    });
    expect(report.confusion.ok.ok).toBe(3);
    expect(report.confusion.critical.ok).toBe(1);
    expect(report.latency).toMatchObject({ n: 7, p50: 400, p95: 900 });
    expect(report.haikuCostUsd).toBeCloseTo(0.08 * 7, 10);
    expect(report.jevCostUsd).toBeCloseTo(0.0003 * 7, 10);
    expect(report.estimatedSavingsIfEnforce).toBeCloseTo(
      0.08 * 4 - 0.0003 * 7,
      10,
    );
    expect(report.jobs.map((job) => job.jobId)).toEqual(["job", "other"]);
    expect(report.jobs[1]).toMatchObject({
      compared: 2,
      severityAgreed: 0,
      followUpAgreed: 0,
      missedCritical: 1,
    });
    expect(report.flagged.missedCritical[0]).toMatchObject({
      jobId: "other",
      haiku: "critical",
      jev: "ok",
      pFollowUp: 0.2,
    });
  });

  it("declares readiness only when enough runs agree on follow-up and nothing critical was missed", () => {
    const clean = Array.from({ length: 60 }, (_, index) => record({}, index));
    const ready = analyzeLedger(clean);
    expect(ready.readiness).toMatchObject({ ready: true, reasons: [] });
    const few = analyzeLedger(clean.slice(0, 10));
    expect(few.readiness.ready).toBe(false);
    expect(few.readiness.reasons.join(" ")).toMatch(/10 of 50/);
    const missed = analyzeLedger([
      ...clean,
      record(
        { haiku: "critical", haikuFollowUp: true, jev: "ok", pFollowUp: 0.1 },
        99,
      ),
    ]);
    expect(missed.readiness.ready).toBe(false);
    expect(missed.readiness.reasons.join(" ")).toMatch(/critical/);
    const disagree = analyzeLedger([
      ...clean,
      ...Array.from({ length: 10 }, (_, index) =>
        record(
          { haiku: "ok", haikuFollowUp: false, jev: "ok", pFollowUp: 0.8 },
          100 + index,
        ),
      ),
    ]);
    expect(disagree.readiness.ready).toBe(false);
    expect(disagree.readiness.reasons.join(" ")).toMatch(/follow-up agreement/);
    // Haiku is not ground truth: runs only Haiku flagged are listed for adjudication, not counted
    // as Jev misses (2026-10-05: all three such runs were Haiku false alarms on the run logs).
    const haikuOnly = analyzeLedger([
      ...clean,
      ...Array.from({ length: 3 }, (_, index) =>
        record(
          { haiku: "warning", haikuFollowUp: true, jev: "ok", pFollowUp: 0.3 },
          200 + index,
        ),
      ),
    ]);
    expect(haikuOnly.haikuOnlyFollowUps).toBe(3);
    expect(haikuOnly.flagged.haikuOnlyFollowUps).toHaveLength(3);
    expect(haikuOnly.readiness).toMatchObject({ ready: true, reasons: [] });
    expect(DEFAULT_READINESS).toEqual({
      minCompared: 50,
      minFollowUpAgreement: 0.9,
      maxMissedCritical: 0,
    });
  });

  it("compares benchmark runs on Haiku's recorded verdict, not on the Jev-driven evaluation", () => {
    const bench = { mode: "benchmark" as const, source: "jev+haiku" as const };
    const report = analyzeLedger([
      record({ ...bench, jev: "ok", pFollowUp: 0.1, haikuBenchmark: { severity: "ok", followUpNeeded: false } }, 0),
      record({ ...bench, jev: "ok", pFollowUp: 0.2, haikuBenchmark: { severity: "warning", followUpNeeded: true } }, 1),
      // Enforce: Haiku only ran because Jev was unsure, a biased sample; it is not a comparison.
      record({ mode: "enforce", source: "jev+haiku", jev: "info", pFollowUp: 0.45, secondOpinion: { severity: "ok", followUpNeeded: false } }, 2),
    ]);
    expect(report).toMatchObject({ compared: 2, severityAgreed: 1, followUpAgreed: 1, haikuOnlyFollowUps: 1 });
    expect(report.confusion.warning.ok).toBe(1);
    expect(report.flagged.haikuOnlyFollowUps[0]).toMatchObject({ haiku: "warning", haikuFollowUp: true, jev: "ok" });
  });

  it("counts enforce-mode Haiku second opinions and how often they raised a follow-up", () => {
    const enforce = { mode: "enforce" as const, source: "jev+haiku" as const };
    const report = analyzeLedger([
      record({ ...enforce, pFollowUp: 0.45, secondOpinion: { severity: "warning", followUpNeeded: true } }, 0),
      record({ ...enforce, pFollowUp: 0.48, secondOpinion: { severity: "ok", followUpNeeded: false } }, 1),
      record({ ...enforce, pFollowUp: 0.55, secondOpinion: { severity: "ok", followUpNeeded: false } }, 2),
      record({ ...enforce, pFollowUp: 0.9 }, 3),
    ]);
    expect(report.compared).toBe(0);
    expect(report.secondOpinions).toEqual({ total: 3, raisedFollowUp: 1 });
    const text = formatLedgerReport(report);
    expect(text).toMatch(/second opinions 3/);
    expect(text).toMatch(/raised a follow-up on 1/);
  });

  it("formats a readable text report with the verdict, matrix, jobs and flagged runs", () => {
    const text = formatLedgerReport(
      analyzeLedger([
        record({}, 0),
        record(
          {
            haiku: "critical",
            haikuFollowUp: true,
            jev: "ok",
            pFollowUp: 0.2,
            job: "other",
            run: "bad-run",
          },
          1,
        ),
      ]),
    );
    expect(text).toContain("NOT READY");
    expect(text).toContain("compared 2");
    expect(text).toContain("other/bad-run");
    expect(text).toContain("critical");
    expect(text).toMatch(/haiku \\ jev|Haiku \\ Jev/);
    expect(text).toContain("Estimated savings if enforce");
    expect(text).toContain("Haiku-only follow-ups");
    expect(text).not.toMatch(/missed follow-up/i);
    const empty = formatLedgerReport(analyzeLedger([]));
    expect(empty).toContain("compared 0");
    expect(empty).toContain("NOT READY");
  });
});
