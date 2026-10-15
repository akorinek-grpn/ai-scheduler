/**
 * One-time: record which host ran each existing run, for runs and preserved activity records
 * written before meta.json carried `host` (2026-10-15). Mirrored history then keeps its origin,
 * so the dashboard never counts a copied run twice.
 *
 *   npx tsx scripts/stamp-run-hosts.ts --host D6H4HDF0Y4 [--before 2026-10-15T09:32:00Z] [--apply]
 *
 * Only records without `host` are touched; with --before, only those that started earlier.
 * Without --apply it prints what it would change.
 */
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const host = arg("host");
const before = arg("before");
const apply = process.argv.includes("--apply");
if (!host || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
  console.error("usage: stamp-run-hosts.ts --host <name> [--before <ISO time>] [--apply]");
  process.exit(2);
}
const beforeMs = before === undefined ? Infinity : Date.parse(before);
if (!Number.isFinite(beforeMs) && before !== undefined) {
  console.error(`--before is not a date: ${before}`);
  process.exit(2);
}

function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.stamp.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function subdirectories(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const counts = { runs: 0, runsSkipped: 0, activity: 0, activitySkipped: 0 };

const runsDir = path.join(PROJECT_ROOT, "data", "runs");
for (const jobId of subdirectories(runsDir)) {
  for (const runId of subdirectories(path.join(runsDir, jobId))) {
    const file = path.join(runsDir, jobId, runId, "meta.json");
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const startedMs = Date.parse(String(meta.startedAt));
    if (meta.host || !(startedMs < beforeMs)) {
      counts.runsSkipped++;
      continue;
    }
    counts.runs++;
    if (apply) writeAtomic(file, JSON.stringify({ ...meta, host }, null, 2));
  }
}

const activityDir = path.join(PROJECT_ROOT, "data", "activity");
for (const jobId of subdirectories(activityDir)) {
  const jobDir = path.join(activityDir, jobId);
  for (const name of fs.readdirSync(jobDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(jobDir, name);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const startedMs = Date.parse(String(record.startedAt));
    if (record.host || !(startedMs < beforeMs)) {
      counts.activitySkipped++;
      continue;
    }
    counts.activity++;
    if (apply) writeAtomic(file, JSON.stringify({ ...record, host }));
  }
}

console.log(
  `${apply ? "stamped" : "would stamp"} host=${host}${before ? ` before ${before}` : ""}: ` +
    `${counts.runs} runs (${counts.runsSkipped} left as they are), ` +
    `${counts.activity} activity records (${counts.activitySkipped} left as they are)`,
);
