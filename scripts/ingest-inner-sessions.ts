/**
 * Backfills the Claude session view for finished script runs on this Mac: for every run whose
 * output.log names a session (autopilot's b2c-toolkit runs) and whose transcript is still in
 * ~/.claude/projects, writes session.log, trace.jsonl and sessions.json into the run
 * (src/daemon/inner-sessions.ts). New runs get them from the daemon; run this once after an
 * upgrade, on each Mac, for its own runs. Only adds files; a run without a transcript is skipped.
 *
 * Usage: npx tsx scripts/ingest-inner-sessions.ts [--job <jobId>]
 */
import fs from "fs";
import path from "path";
import { ingestInnerSessions } from "../src/daemon/inner-sessions";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const runsDir = path.join(root, "data", "runs");
const jobArg = process.argv.indexOf("--job");
const onlyJob = jobArg >= 0 ? process.argv[jobArg + 1] : undefined;

let scanned = 0;
let ingested = 0;
for (const jobId of fs.readdirSync(runsDir)) {
  if (onlyJob && jobId !== onlyJob) continue;
  const jobDir = path.join(runsDir, jobId);
  if (!fs.lstatSync(jobDir).isDirectory()) continue;
  for (const runId of fs.readdirSync(jobDir)) {
    const runDir = path.join(jobDir, runId);
    if (runId === "latest" || !fs.lstatSync(runDir).isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
      const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8"));
      if (meta?.jobConfig?.type !== "script" || status?.status === "running") continue;
      scanned += 1;
      if (ingestInnerSessions(runDir, { final: true }).length > 0) ingested += 1;
    } catch {
      // unreadable run: skip
    }
  }
}
console.log(`script runs scanned: ${scanned}, with a Claude session copied in: ${ingested}`);
