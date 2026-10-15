/**
 * npm run janitor [-- --apply] [--processes | --disk]
 *
 * Reports leftover dev-server and MCP-server process trees and reclaimable cache space. Without
 * --apply it changes nothing except its own observation file (data/janitor/state.json), which the
 * next run needs to tell an idle tree from a working one. Rules: src/janitor/processes.ts;
 * settings and the protect list: janitor.yaml.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  diskFree,
  dockerRunning,
  hasBinary,
  readMachine,
  sizeGb,
  workingDirectories,
} from "../src/janitor/collect";
import {
  cleanerCommands,
  expireDirectories,
  loadJanitorConfig,
} from "../src/janitor/disk";
import {
  nextState,
  planUnits,
  type JanitorState,
  type UnitReport,
} from "../src/janitor/processes";
import { stopProcesses } from "../src/janitor/stop";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const doProcesses = !args.includes("--disk");
const doDisk = !args.includes("--processes");
const projectRoot = path.resolve(import.meta.dirname, "..");
const stateFile = path.join(projectRoot, "data", "janitor", "state.json");
const home = os.homedir();
const now = new Date();
let failed = false;

const short = (value: string): string =>
  value.startsWith(home) ? `~${value.slice(home.length)}` : value;
const memory = (megabytes: number): string =>
  megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
const gigabytes = (value: number | null): string =>
  value === null ? "size unknown" : `${value.toFixed(1)} GB`;
function duration(minutes: number): string {
  const total = Math.round(minutes);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  if (days > 0) return `${days}d${hours}h`;
  return hours > 0 ? `${hours}h${total % 60}m` : `${total}m`;
}

function readState(): JanitorState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as JanitorState;
  } catch {
    return null;
  }
}

const LABEL: Record<UnitReport["verdict"], [string, string]> = {
  stop: ["STOPPED", "WOULD STOP"],
  observe: ["OBSERVE", "OBSERVE"],
  busy: ["BUSY", "BUSY"],
  young: ["YOUNG", "YOUNG"],
  protected: ["PROTECTED", "PROTECTED"],
};

async function processes(): Promise<void> {
  const config = loadJanitorConfig(path.join(projectRoot, "janitor.yaml"));
  const reading = readMachine(projectRoot, now);
  const previous = readState();
  // Working directories are only looked up for the trees that matter, then the plan is redone
  // with them, because the protect list and the project check can depend on a cwd.
  const first = planUnits(reading.snapshot, config, previous);
  reading.snapshot.cwd = workingDirectories(first.flatMap((unit) => unit.pids));
  const units = planUnits(reading.snapshot, config, previous);

  if (reading.physMem) console.log(reading.physMem);
  if (reading.swap) console.log(`Swap: ${reading.swap}`);
  console.log(
    `\nDetached dev-server and MCP-server trees: ${units.length}` +
      (previous
        ? ` (previous observation ${previous.observedAt})`
        : " (no previous observation: nothing can be judged idle yet)"),
  );
  let reclaimMb = 0;
  for (const unit of units) {
    let label = LABEL[unit.verdict][apply ? 0 : 1];
    let outcome = "";
    if (unit.verdict === "stop") {
      reclaimMb += unit.footprintMb;
      if (apply) {
        const result = await stopProcesses(unit.identities);
        if (!result.stopped) {
          failed = true;
          label = "STOP FAILED";
          outcome = ` survivors=${result.survivors.join(",") || "-"} skipped=${result.skipped.join(",") || "-"}`;
        } else if (result.forced.length > 0) {
          outcome = ` (SIGKILL needed for ${result.forced.join(",")})`;
        }
      }
    }
    const rate =
      unit.cpuRatePerHour === null
        ? "cpu n/a"
        : `cpu ${Math.round(unit.cpuRatePerHour)} s/h`;
    console.log(
      `  ${label.padEnd(11)} ${unit.kind.padEnd(10)} pid ${String(unit.rootPid).padEnd(6)} ` +
        `age ${duration(unit.ageMinutes).padEnd(7)} ${memory(unit.footprintMb).padEnd(8)} ${rate.padEnd(12)}` +
        `${unit.ports.length ? ` port ${unit.ports.join(",")}` : ""}${unit.cwd ? ` ${short(unit.cwd)}` : ""}${outcome}`,
    );
    console.log(`              ${short(unit.command).slice(0, 140)}`);
    console.log(
      `              ${unit.reason} (${unit.pids.length} process${unit.pids.length === 1 ? "" : "es"})`,
    );
  }
  const count = units.filter((unit) => unit.verdict === "stop").length;
  console.log(
    count === 0
      ? "Nothing to stop."
      : `${apply ? "Stopped" : "Would stop"} ${count} tree${count === 1 ? "" : "s"}, about ${memory(reclaimMb)} of memory.`,
  );

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(nextState(now, units), null, 2));
}

function disk(): void {
  const config = loadJanitorConfig(path.join(projectRoot, "janitor.yaml"));
  const before = diskFree(home);
  if (before)
    console.log(
      `\nDisk: ${before.freeGb.toFixed(1)} GB free of ${before.totalGb.toFixed(0)} GB`,
    );
  for (const cleaner of cleanerCommands(
    config.disk,
    hasBinary,
    dockerRunning,
  )) {
    const command = cleaner.argv.join(" ");
    if (!apply) {
      const size = cleaner.sizePath
        ? ` ${gigabytes(sizeGb([cleaner.sizePath]))},`
        : "";
      console.log(`  ${cleaner.label}:${size} would run \`${command}\``);
      continue;
    }
    const free = diskFree(home);
    const result = spawnSync(cleaner.argv[0], cleaner.argv.slice(1), {
      encoding: "utf8",
      timeout: 15 * 60_000,
    });
    const after = diskFree(home);
    const freed =
      free && after
        ? `, freed ${(after.freeGb - free.freeGb).toFixed(1)} GB`
        : "";
    if (result.status === 0) {
      console.log(`  ${cleaner.label}: ran \`${command}\`${freed}`);
    } else {
      failed = true;
      const detail = (
        result.stderr ||
        result.stdout ||
        String(result.error ?? "")
      )
        .trim()
        .split("\n")
        .at(-1);
      console.log(
        `  ${cleaner.label}: \`${command}\` FAILED (${detail ?? "no output"})`,
      );
    }
  }
  for (const rule of config.disk.expire) {
    // Sized before removal; the list itself does not depend on --apply.
    const candidates = expireDirectories(rule, now, false);
    const size = candidates.length
      ? sizeGb(candidates.map((entry) => entry.path))
      : 0;
    const entries = apply ? expireDirectories(rule, now, true) : candidates;
    const kept = entries.filter((entry) => apply && !entry.removed);
    if (kept.length > 0) failed = true;
    console.log(
      `  ${short(rule.path)} (untouched for ${rule.maxAgeDays}+ days): ` +
        `${apply ? "removed" : "would remove"} ${entries.length - kept.length} director${entries.length - kept.length === 1 ? "y" : "ies"}, ${gigabytes(size)}` +
        (kept.length ? `; ${kept.length} could NOT be removed` : ""),
    );
    for (const entry of entries.slice(0, 8))
      console.log(
        `      ${short(entry.path)} (${Math.round(entry.ageDays)} days)`,
      );
    if (entries.length > 8) console.log(`      ... ${entries.length - 8} more`);
  }
  const after = diskFree(home);
  if (apply && before && after)
    console.log(
      `Disk after: ${after.freeGb.toFixed(1)} GB free (${(after.freeGb - before.freeGb).toFixed(1)} GB reclaimed)`,
    );
}

if (process.getuid?.() === 0) {
  console.error("janitor: refusing to run as root");
  process.exit(1);
}
console.log(
  `Janitor ${now.toISOString()} - ${apply ? "APPLY: stopping and cleaning" : "REPORT ONLY: nothing is stopped or deleted"}`,
);
try {
  if (doProcesses) await processes();
  if (doDisk) disk();
} catch (error) {
  failed = true;
  console.error(
    `janitor: ${error instanceof Error ? error.message : String(error)}`,
  );
}
process.exitCode = failed ? 1 : 0;
