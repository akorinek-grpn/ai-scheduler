/**
 * npm run jev:report [-- --days N] [--json] [--min-compared N]
 * Prints the enforce-readiness report from data/evaluations/*.jsonl.
 */
import path from "node:path";
import { readEvaluationRecords } from "../src/daemon/evaluation-log";
import {
  analyzeLedger,
  DEFAULT_READINESS,
  formatLedgerReport,
} from "../src/daemon/jev-report";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const days = Number(option("--days") ?? 7);
const minCompared = Number(
  option("--min-compared") ?? DEFAULT_READINESS.minCompared,
);
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const projectRoot = path.resolve(import.meta.dirname, "..");
const records = readEvaluationRecords(projectRoot, { since });
const report = analyzeLedger(records, { ...DEFAULT_READINESS, minCompared });

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `window: last ${days} day(s), ${records.length} ledger record(s)`,
  );
  console.log(formatLedgerReport(report));
}
process.exitCode = report.readiness.ready ? 0 : 1;
