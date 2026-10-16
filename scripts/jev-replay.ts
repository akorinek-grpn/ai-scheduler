#!/usr/bin/env tsx
/**
 * Replays retained runs through the Jev decision client twice: with the shipped questions and
 * with an alternative set, so a wording or threshold change is measured on real logs before it
 * ships (2026-10-15). Reads the evaluation ledger for the probability recorded at the time, which
 * also checks that a replay reproduces it. Costs ~$0.00005 per call; nothing is written back.
 *
 *   ./scripts/with-env.sh npx tsx scripts/jev-replay.ts --ledger data/evaluations/2026-10.jsonl \
 *     --roots data/runs,data/hosts/FL2R12XFMX/data/runs --variant variant.json [--limit 50] \
 *     [--concurrency 4] [--out replay.jsonl]
 */
import fs from "fs";
import path from "path";

import {
  DECISION_QUESTIONS,
  requestRunDecision,
  type DecisionInput,
  type DecisionQuestions,
} from "../src/daemon/decision";
import type { RunStatus } from "../src/shared/types";

type Args = Record<string, string>;
const args: Args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1] ?? "";
}
const ledgerPath = args.ledger;
const roots = (args.roots ?? "").split(",").filter(Boolean);
const variantPath = args.variant;
const limit = Number(args.limit ?? 0) || Infinity;
const concurrency = Number(args.concurrency ?? 4) || 4;
const outPath = args.out ?? "";
if (!ledgerPath || roots.length === 0 || !variantPath) {
  console.error("usage: --ledger <file> --roots a,b --variant <json> [--limit N] [--concurrency N] [--out file]");
  process.exit(2);
}
const variant = JSON.parse(fs.readFileSync(variantPath, "utf-8")) as DecisionQuestions;

interface Ledger {
  jobId: string;
  jobName: string;
  status: RunStatus;
  exitCode: number | null;
  decision?: { followUpProbability: number | null; severity: string | null; state: string };
}
const ledger = new Map<string, Ledger>();
for (const line of fs.readFileSync(ledgerPath, "utf-8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as Ledger & { runId: string };
  if (rec.decision?.state === "complete") ledger.set(rec.runId, rec);
}

/** The outcomes Haiku over-flags (2026-10-15 log review); the replay reports them separately. */
const CLASSES: Array<[string, RegExp]> = [
  ["deferred-lock", /Deferred - autopilot-daily holds the lock/],
  ["no-eligible-ticket", /no eligible ticket today/],
  ["janitor-report", /Would stop \d+ trees/],
  ["nothing-to-reply", /acted on 0 of 0|Nothing needed a reply|0 conversation items were pending/i],
  ["approved-clean", /APPROVED\*\* at|Verdict \| Findings[\s\S]*APPROVED/],
];
function classify(log: string): string {
  const tail = log.split("\n").slice(-200).join("\n");
  for (const [name, rx] of CLASSES) if (rx.test(tail)) return name;
  return "other";
}

interface Job { runId: string; jobId: string; input: DecisionInput; recorded: number | null; recordedSev: string | null; cls: string }
const jobs: Job[] = [];
const seen = new Set<string>();
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const jobId of fs.readdirSync(root)) {
    const jobDir = path.join(root, jobId);
    if (!fs.statSync(jobDir).isDirectory()) continue;
    for (const runId of fs.readdirSync(jobDir)) {
      if (!/^\d{4}-/.test(runId) || seen.has(runId)) continue;
      const rec = ledger.get(runId);
      const logPath = path.join(jobDir, runId, "output.log");
      const statusPath = path.join(jobDir, runId, "status.json");
      if (!rec || !fs.existsSync(logPath) || !fs.existsSync(statusPath)) continue;
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { status: RunStatus; exitCode: number | null };
      const output = fs.readFileSync(logPath, "utf-8");
      seen.add(runId);
      jobs.push({
        runId, jobId, cls: classify(output),
        input: { jobName: rec.jobName, status: status.status, exitCode: status.exitCode, output },
        recorded: rec.decision?.followUpProbability ?? null, recordedSev: rec.decision?.severity ?? null,
      });
    }
  }
}
jobs.sort((a, b) => a.runId.localeCompare(b.runId));
const work = jobs.slice(-limit);
console.log(`replaying ${work.length} runs (${jobs.length} retained with a ledger decision) with ${concurrency} in flight`);

interface Row { runId: string; jobId: string; status: RunStatus; cls: string; recorded: number | null; recordedSev: string | null;
  control: number | null; controlSev: string | null; variant: number | null; variantSev: string | null; variantKind: string | null; error: string | null }
const rows: Row[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < work.length) {
    const j = work[next++];
    const [c, v] = await Promise.all([
      requestRunDecision(j.input, { questions: DECISION_QUESTIONS }),
      requestRunDecision(j.input, { questions: variant }),
    ]);
    rows.push({
      runId: j.runId, jobId: j.jobId, status: j.input.status, cls: j.cls, recorded: j.recorded, recordedSev: j.recordedSev,
      control: c.decision?.followUp.probability ?? null, controlSev: c.decision?.severity.label ?? null,
      variant: v.decision?.followUp.probability ?? null, variantSev: v.decision?.severity.label ?? null,
      variantKind: v.decision?.failureKind.choice ?? null, error: c.error ?? v.error ?? null,
    });
    if (rows.length % 50 === 0) console.log(`  ${rows.length}/${work.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
if (outPath) fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const ok = rows.filter((r) => r.control !== null && r.variant !== null);
const errors = rows.length - ok.length;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "n/a");
console.log(`\ndone: ${ok.length} replayed, ${errors} errors`);
const drift = ok.filter((r) => r.recorded !== null).map((r) => Math.abs((r.control as number) - (r.recorded as number)));
console.log(`determinism: |control - recorded| mean ${mean(drift)} max ${drift.length ? Math.max(...drift).toFixed(2) : "n/a"} (n=${drift.length})`);

console.log("\nby status (n | control: mean p, flagged@0.5, flagged@0.6 | variant: mean p, flagged@0.5, flagged@0.6 | min p control/variant):");
for (const st of ["success", "timeout", "failed", "partial"] as const) {
  const g = ok.filter((r) => r.status === st);
  if (!g.length) continue;
  const c = g.map((r) => r.control as number), v = g.map((r) => r.variant as number);
  console.log(`  ${st.padEnd(8)} n=${String(g.length).padStart(4)} | ${mean(c)} ${pct(c.filter((p) => p >= 0.5).length, g.length).padStart(4)} ${pct(c.filter((p) => p >= 0.6).length, g.length).padStart(4)} | ${mean(v)} ${pct(v.filter((p) => p >= 0.5).length, g.length).padStart(4)} ${pct(v.filter((p) => p >= 0.6).length, g.length).padStart(4)} | ${Math.min(...c).toFixed(2)}/${Math.min(...v).toFixed(2)}`);
}
console.log("\nsuccess runs by outcome class (n | control mean p, >=0.5, >=0.6 | variant mean p, >=0.5, >=0.6 | severity ok share control/variant):");
for (const cls of [...CLASSES.map(([n]) => n), "other"]) {
  const g = ok.filter((r) => r.status === "success" && r.cls === cls);
  if (!g.length) continue;
  const c = g.map((r) => r.control as number), v = g.map((r) => r.variant as number);
  console.log(`  ${cls.padEnd(19)} n=${String(g.length).padStart(4)} | ${mean(c)} ${pct(c.filter((p) => p >= 0.5).length, g.length).padStart(4)} ${pct(c.filter((p) => p >= 0.6).length, g.length).padStart(4)} | ${mean(v)} ${pct(v.filter((p) => p >= 0.5).length, g.length).padStart(4)} ${pct(v.filter((p) => p >= 0.6).length, g.length).padStart(4)} | ${pct(g.filter((r) => r.controlSev === "ok").length, g.length)}/${pct(g.filter((r) => r.variantSev === "ok").length, g.length)}`);
}
console.log("\nP(follow-up) histogram (control vs variant), success runs only:");
for (let lo = 0; lo < 1; lo += 0.1) {
  const inBin = (p: number) => p >= lo && (p < lo + 0.1 || (lo >= 0.9 && p <= 1));
  const g = ok.filter((r) => r.status === "success");
  console.log(`  ${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}  control ${String(g.filter((r) => inBin(r.control as number)).length).padStart(4)}  variant ${String(g.filter((r) => inBin(r.variant as number)).length).padStart(4)}`);
}
const shifts = new Map<string, number>();
for (const r of ok.filter((r) => r.status === "success" && r.controlSev !== r.variantSev)) {
  const k = `${r.controlSev}->${r.variantSev}`; shifts.set(k, (shifts.get(k) ?? 0) + 1);
}
console.log("\nseverity label changes on success runs:", Object.fromEntries(shifts));
const kinds = new Map<string, number>();
for (const r of ok.filter((r) => r.status === "success")) kinds.set(r.variantKind ?? "null", (kinds.get(r.variantKind ?? "null") ?? 0) + 1);
console.log("variant failure_kind on success runs:", Object.fromEntries(kinds));
