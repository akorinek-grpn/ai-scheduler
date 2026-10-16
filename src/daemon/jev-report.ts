/**
 * Enforce-readiness analysis of the evaluation ledger (data/evaluations/*.jsonl).
 *
 * A run is "compared" when Haiku and Jev both judged it independently: Haiku decided and Jev was
 * recorded beside it (shadow), or Jev decided and Haiku's verdict was recorded beside it (benchmark,
 * `evaluation.haikuBenchmark`). Enforce-mode Haiku calls are not comparisons: Haiku only runs there
 * when Jev flagged or was unsure, a biased sample.
 * Haiku is not ground truth: when the 2026-10-05 adjudication checked the disagreements against the
 * run logs, all three runs only Haiku flagged for follow-up were Haiku false alarms, and two runs
 * only Jev flagged were real problems. So readiness is gated on follow-up agreement and on zero
 * missed criticals; follow-ups only one model asked for are listed in both directions for a person
 * to adjudicate, never counted as Jev misses. Enforce-mode Haiku second opinions (see
 * SECOND_OPINION_BAND) are counted separately. `npm run jev:report` prints this; the thresholds
 * live here.
 */
import type { EvalSeverity, EvaluationLogRecord } from "@shared/types";
import { FOLLOW_UP_THRESHOLD } from "./decision";
import { SECOND_OPINION_BAND } from "./evaluator";

export interface ReadinessThresholds {
  minCompared: number;
  minFollowUpAgreement: number;
  maxMissedCritical: number;
}

export const DEFAULT_READINESS: ReadinessThresholds = {
  minCompared: 50,
  minFollowUpAgreement: 0.9,
  maxMissedCritical: 0,
};

const SEVERITIES: readonly EvalSeverity[] = [
  "ok",
  "info",
  "warning",
  "critical",
];

export interface FlaggedRun {
  jobId: string;
  runId: string;
  ts: string;
  haiku: EvalSeverity | null;
  haikuFollowUp: boolean | null;
  jev: EvalSeverity | null;
  pFollowUp: number | null;
}

export interface JobReport {
  jobId: string;
  jobName: string;
  evaluated: number;
  compared: number;
  severityAgreed: number;
  followUpAgreed: number;
  haikuOnlyFollowUps: number;
  missedCritical: number;
  jevOnlyFollowUps: number;
  jevLatencyP50Ms: number | null;
  jevCostUsd: number;
  haikuCostUsd: number;
}

export interface LedgerReport {
  thresholds: ReadinessThresholds;
  since: string | null;
  until: string | null;
  evaluated: number;
  withDecision: number;
  compared: number;
  severityAgreed: number;
  followUpAgreed: number;
  haikuOnlyFollowUps: number;
  missedCritical: number;
  jevOnlyFollowUps: number;
  /** Enforce mode: runs where Haiku gave a second opinion, and where its follow-up overrode Jev's no. */
  secondOpinions: { total: number; raisedFollowUp: number };
  confusion: Record<EvalSeverity, Record<EvalSeverity, number>>;
  latency: { n: number; p50: number | null; p95: number | null };
  haikuCostUsd: number;
  jevCostUsd: number;
  estimatedSavingsIfEnforce: number;
  jobs: JobReport[];
  flagged: {
    missedCritical: FlaggedRun[];
    haikuOnlyFollowUps: FlaggedRun[];
    jevOnlyFollowUps: FlaggedRun[];
  };
  readiness: { ready: boolean; reasons: string[] };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

function emptyConfusion(): Record<EvalSeverity, Record<EvalSeverity, number>> {
  return Object.fromEntries(
    SEVERITIES.map((row) => [
      row,
      Object.fromEntries(SEVERITIES.map((column) => [column, 0])),
    ]),
  ) as Record<EvalSeverity, Record<EvalSeverity, number>>;
}

function flag(
  record: EvaluationLogRecord,
  haiku: { severity: EvalSeverity; followUpNeeded: boolean },
): FlaggedRun {
  return {
    jobId: record.jobId,
    runId: record.runId,
    ts: record.ts,
    haiku: haiku.severity,
    haikuFollowUp: haiku.followUpNeeded,
    jev: record.decision.severity,
    pFollowUp: record.decision.followUpProbability,
  };
}

export function analyzeLedger(
  records: EvaluationLogRecord[],
  thresholds: ReadinessThresholds = DEFAULT_READINESS,
): LedgerReport {
  const sorted = [...records].sort(
    (left, right) => Date.parse(left.ts) - Date.parse(right.ts),
  );
  const jobs = new Map<string, JobReport & { latencies: number[] }>();
  const latencies: number[] = [];
  const confusion = emptyConfusion();
  const flagged: LedgerReport["flagged"] = {
    missedCritical: [],
    haikuOnlyFollowUps: [],
    jevOnlyFollowUps: [],
  };
  const secondOpinions = { total: 0, raisedFollowUp: 0 };
  let withDecision = 0;
  let compared = 0;
  let severityAgreed = 0;
  let followUpAgreed = 0;
  let haikuCostUsd = 0;
  let jevCostUsd = 0;
  let avoidedHaikuUsd = 0;

  for (const record of sorted) {
    const job = jobs.get(record.jobId) ?? {
      jobId: record.jobId,
      jobName: record.jobName,
      evaluated: 0,
      compared: 0,
      severityAgreed: 0,
      followUpAgreed: 0,
      haikuOnlyFollowUps: 0,
      missedCritical: 0,
      jevOnlyFollowUps: 0,
      jevLatencyP50Ms: null,
      jevCostUsd: 0,
      haikuCostUsd: 0,
      latencies: [],
    };
    jobs.set(record.jobId, job);
    job.evaluated += 1;
    const { evaluation, decision } = record;
    if (evaluation.haikuCostUsd !== null) {
      haikuCostUsd += evaluation.haikuCostUsd;
      job.haikuCostUsd += evaluation.haikuCostUsd;
    }
    const hasDecision =
      decision.state === "complete" &&
      decision.severity !== null &&
      decision.followUpProbability !== null;
    if (!hasDecision) continue;
    withDecision += 1;
    if (decision.costUsd !== null) {
      jevCostUsd += decision.costUsd;
      job.jevCostUsd += decision.costUsd;
    }
    if (decision.latencyMs !== null) {
      latencies.push(decision.latencyMs);
      job.latencies.push(decision.latencyMs);
    }
    if (evaluation.secondOpinion) {
      secondOpinions.total += 1;
      if (
        evaluation.secondOpinion.followUpNeeded &&
        (decision.followUpProbability as number) < 0.5
      )
        secondOpinions.raisedFollowUp += 1;
    }
    const haikuVerdict =
      evaluation.source === "haiku" &&
      evaluation.severity !== null &&
      evaluation.followUpNeeded !== null
        ? {
            severity: evaluation.severity,
            followUpNeeded: evaluation.followUpNeeded,
          }
        : (evaluation.haikuBenchmark ?? null);
    if (!haikuVerdict) continue;
    compared += 1;
    job.compared += 1;
    const jevSeverity = decision.severity as EvalSeverity;
    const jevFollowUp =
      (decision.followUpProbability as number) >= FOLLOW_UP_THRESHOLD;
    const haikuSeverity = haikuVerdict.severity;
    const haikuFollowUp = haikuVerdict.followUpNeeded;
    confusion[haikuSeverity][jevSeverity] += 1;
    if (haikuSeverity === jevSeverity) {
      severityAgreed += 1;
      job.severityAgreed += 1;
    }
    if (haikuFollowUp === jevFollowUp) {
      followUpAgreed += 1;
      job.followUpAgreed += 1;
    }
    if (haikuFollowUp && !jevFollowUp) {
      job.haikuOnlyFollowUps += 1;
      flagged.haikuOnlyFollowUps.push(flag(record, haikuVerdict));
    }
    if (
      haikuSeverity === "critical" &&
      jevSeverity !== "critical" &&
      jevSeverity !== "warning"
    ) {
      job.missedCritical += 1;
      flagged.missedCritical.push(flag(record, haikuVerdict));
    }
    if (!haikuFollowUp && jevFollowUp) {
      job.jevOnlyFollowUps += 1;
      flagged.jevOnlyFollowUps.push(flag(record, haikuVerdict));
    }
    const clean =
      (jevSeverity === "ok" || jevSeverity === "info") && !jevFollowUp;
    if (clean && evaluation.haikuCostUsd !== null)
      avoidedHaikuUsd += evaluation.haikuCostUsd;
  }

  const reasons: string[] = [];
  const followUpAgreement = compared ? followUpAgreed / compared : 0;
  if (compared < thresholds.minCompared)
    reasons.push(`only ${compared} of ${thresholds.minCompared} compared runs`);
  if (compared && followUpAgreement < thresholds.minFollowUpAgreement)
    reasons.push(
      `follow-up agreement ${(followUpAgreement * 100).toFixed(1)}% is below ${(thresholds.minFollowUpAgreement * 100).toFixed(0)}%`,
    );
  if (flagged.missedCritical.length > thresholds.maxMissedCritical)
    reasons.push(
      `${flagged.missedCritical.length} Haiku critical run(s) Jev rated below warning`,
    );

  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  return {
    thresholds,
    since: sorted[0]?.ts ?? null,
    until: sorted.at(-1)?.ts ?? null,
    evaluated: sorted.length,
    withDecision,
    compared,
    severityAgreed,
    followUpAgreed,
    haikuOnlyFollowUps: flagged.haikuOnlyFollowUps.length,
    missedCritical: flagged.missedCritical.length,
    jevOnlyFollowUps: flagged.jevOnlyFollowUps.length,
    secondOpinions,
    confusion,
    latency: {
      n: sortedLatencies.length,
      p50: percentile(sortedLatencies, 0.5),
      p95: percentile(sortedLatencies, 0.95),
    },
    haikuCostUsd,
    jevCostUsd,
    estimatedSavingsIfEnforce: avoidedHaikuUsd - jevCostUsd,
    jobs: [...jobs.values()]
      .map(({ latencies: jobLatencies, ...job }) => ({
        ...job,
        jevLatencyP50Ms: percentile(
          [...jobLatencies].sort((left, right) => left - right),
          0.5,
        ),
      }))
      .sort(
        (left, right) =>
          right.compared - left.compared ||
          left.jobId.localeCompare(right.jobId),
      ),
    flagged,
    readiness: { ready: reasons.length === 0, reasons },
  };
}

const usd = (value: number): string =>
  Math.abs(value) < 0.01 && value !== 0
    ? `$${value.toFixed(5)}`
    : `$${value.toFixed(2)}`;
const pct = (part: number, whole: number): string =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

function flaggedLines(title: string, runs: FlaggedRun[]): string[] {
  if (!runs.length) return [];
  const lines = [`${title} (${runs.length}):`];
  for (const run of runs.slice(0, 10)) {
    lines.push(
      `  ${run.jobId}/${run.runId}  haiku=${run.haiku}${run.haikuFollowUp ? " +follow-up" : ""}  jev=${run.jev} p(follow-up)=${run.pFollowUp === null ? "n/a" : run.pFollowUp.toFixed(2)}  ${run.ts}`,
    );
  }
  if (runs.length > 10) lines.push(`  ... ${runs.length - 10} more`);
  return lines;
}

export function formatLedgerReport(report: LedgerReport): string {
  const lines: string[] = [];
  lines.push(
    `Jev shadow report  ${report.since ?? "-"} .. ${report.until ?? "-"}`,
  );
  lines.push(
    `evaluated ${report.evaluated} · with Jev decision ${report.withDecision} · compared ${report.compared} (both judged the run: shadow or benchmark)`,
  );
  lines.push(
    `severity agreement ${report.severityAgreed}/${report.compared} (${pct(report.severityAgreed, report.compared)}) · follow-up agreement ${report.followUpAgreed}/${report.compared} (${pct(report.followUpAgreed, report.compared)})`,
  );
  lines.push(
    `missed criticals ${report.missedCritical} · Haiku-only follow-ups ${report.haikuOnlyFollowUps} · Jev-only follow-ups ${report.jevOnlyFollowUps} (adjudicate both against the run log)`,
  );
  lines.push(
    `enforce second opinions ${report.secondOpinions.total} (Jev P(follow-up) ${SECOND_OPINION_BAND.min.toFixed(2)}-${SECOND_OPINION_BAND.max.toFixed(2)}) · Haiku raised a follow-up on ${report.secondOpinions.raisedFollowUp}`,
  );
  lines.push(
    `Jev latency p50 ${report.latency.p50 ?? "n/a"} ms · p95 ${report.latency.p95 ?? "n/a"} ms (n=${report.latency.n})`,
  );
  lines.push(
    `Haiku spend ${usd(report.haikuCostUsd)} · Jev spend ${usd(report.jevCostUsd)} · Estimated savings if enforce ${usd(report.estimatedSavingsIfEnforce)}`,
  );
  lines.push("");
  lines.push("Confusion matrix (rows Haiku \\ Jev columns):");
  lines.push(
    `  ${pad("haiku \\ jev", 14)}${SEVERITIES.map((column) => pad(column, 10)).join("")}`,
  );
  for (const row of SEVERITIES)
    lines.push(
      `  ${pad(row, 14)}${SEVERITIES.map((column) => pad(String(report.confusion[row][column]), 10)).join("")}`,
    );
  lines.push("");
  lines.push("Per job:");
  lines.push(
    `  ${pad("job", 36)}${pad("evaluated", 10)}${pad("compared", 9)}${pad("sev agree", 10)}${pad("f/u agree", 10)}${pad("haiku f/u", 11)}${pad("p50 ms", 8)}${pad("jev $", 10)}haiku $`,
  );
  for (const job of report.jobs) {
    lines.push(
      `  ${pad(job.jobId.slice(0, 35), 36)}${pad(String(job.evaluated), 10)}${pad(String(job.compared), 9)}${pad(`${job.severityAgreed}/${job.compared}`, 10)}${pad(`${job.followUpAgreed}/${job.compared}`, 10)}${pad(String(job.haikuOnlyFollowUps), 11)}${pad(job.jevLatencyP50Ms === null ? "n/a" : String(job.jevLatencyP50Ms), 8)}${pad(usd(job.jevCostUsd), 10)}${usd(job.haikuCostUsd)}`,
    );
  }
  lines.push("");
  lines.push(
    ...flaggedLines(
      "Missed criticals (Haiku critical, Jev below warning)",
      report.flagged.missedCritical,
    ),
  );
  lines.push(
    ...flaggedLines(
      "Haiku-only follow-ups (Haiku flagged, Jev p<0.5; Haiku may be wrong)",
      report.flagged.haikuOnlyFollowUps,
    ),
  );
  lines.push(
    ...flaggedLines(
      "Jev-only follow-ups (spot-check: Jev may be right)",
      report.flagged.jevOnlyFollowUps,
    ),
  );
  lines.push("");
  lines.push(
    report.readiness.ready
      ? `READY for enforce: ${report.compared} compared runs, follow-up agreement ${pct(report.followUpAgreed, report.compared)}, no missed criticals.`
      : `NOT READY for enforce: ${report.readiness.reasons.join("; ")}.`,
  );
  lines.push(
    "note: Haiku is a non-deterministic baseline, not ground truth; adjudicate disagreements against the run log or outcome.",
  );
  lines.push(
    `thresholds: compared >= ${report.thresholds.minCompared}, follow-up agreement >= ${(report.thresholds.minFollowUpAgreement * 100).toFixed(0)}%, missed criticals <= ${report.thresholds.maxMissedCritical}`,
  );
  return lines.join("\n");
}
