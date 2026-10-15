/**
 * Reads the machine for the janitor: processes, listening ports, launchd services, memory
 * footprints and disk usage. macOS tools only (ps, lsof, launchctl, top, df, du); every reader
 * degrades to "unknown" instead of failing, so a missing figure never turns into a wrong verdict.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parsePs, type Snapshot } from "./processes";

function run(command: string, args: string[], timeoutMs = 30_000): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : "";
}

/** `ps -axo pid=,lstart=` -> pid -> "Mon Oct  5 15:27:17 2026". */
function startTimes(): Map<number, string> {
  const started = new Map<number, string>();
  for (const line of run("ps", ["-axo", "pid=,lstart="]).split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (match) started.set(Number(match[1]), match[2]);
  }
  return started;
}

function listeningPorts(): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of run("lsof", [
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fpn",
  ]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (!Number.isInteger(port)) continue;
      const known = ports.get(pid) ?? [];
      if (!known.includes(port)) known.push(port);
      ports.set(pid, known);
    }
  }
  return ports;
}

/** Pids launchd runs as a service. Orphans reparented to launchd are not in this list. */
function launchdServices(): Set<number> {
  const pids = new Set<number>();
  for (const line of run("launchctl", ["list"]).split("\n")) {
    const pid = Number(line.split("\t")[0]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

const UNIT_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  K: 1 / 1024,
  M: 1,
  G: 1024,
  T: 1024 * 1024,
};

interface TopReading {
  footprintMb: Map<number, number>;
  /** top's "PhysMem: ..." header line, when it printed one. */
  physMem: string | null;
}

/** Physical footprint per pid: unlike RSS it counts compressed and swapped-out memory. */
function readTop(): TopReading {
  const footprintMb = new Map<number, number>();
  let physMem: string | null = null;
  for (const line of run("top", ["-l", "1", "-stats", "pid,mem"], 60_000).split(
    "\n",
  )) {
    if (line.startsWith("PhysMem:")) physMem = line.trim();
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])/.exec(line);
    if (match)
      footprintMb.set(Number(match[1]), Number(match[2]) * UNIT_MB[match[3]]);
  }
  return { footprintMb, physMem };
}

function daemonPid(projectRoot: string): number | null {
  try {
    const { pid } = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "data", "daemon.json"), "utf8"),
    ) as { pid?: unknown };
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

export interface MachineReading {
  snapshot: Snapshot;
  physMem: string | null;
  swap: string | null;
}

/** Everything `planUnits` needs except working directories, which are looked up per candidate. */
export function readMachine(
  projectRoot: string,
  now = new Date(),
): MachineReading {
  const started = startTimes();
  const processes = parsePs(
    run("ps", ["-axo", "pid=,ppid=,pgid=,uid=,etime=,time=,rss=,command="]),
  ).map((process) => ({
    ...process,
    startedAt: started.get(process.pid) ?? "",
  }));
  const top = readTop();
  return {
    snapshot: {
      now,
      uid: process.getuid?.() ?? -1,
      processes,
      listening: listeningPorts(),
      launchdManaged: launchdServices(),
      cwd: new Map(),
      footprintMb: top.footprintMb,
      daemonPid: daemonPid(projectRoot),
      projectRoot,
    },
    physMem: top.physMem,
    swap: run("sysctl", ["-n", "vm.swapusage"]).trim() || null,
  };
}

export function workingDirectories(pids: number[]): Map<number, string> {
  const directories = new Map<number, string>();
  if (pids.length === 0) return directories;
  let pid = 0;
  for (const line of run("lsof", [
    "-a",
    "-d",
    "cwd",
    "-Fn",
    "-p",
    pids.join(","),
  ]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) directories.set(pid, line.slice(1));
  }
  return directories;
}

export interface DiskFree {
  totalGb: number;
  freeGb: number;
}

export function diskFree(directory: string): DiskFree | null {
  const row = run("df", ["-k", directory]).trim().split("\n").at(-1);
  const columns = row?.split(/\s+/) ?? [];
  const total = Number(columns[1]);
  const free = Number(columns[3]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { totalGb: total / 1024 / 1024, freeGb: free / 1024 / 1024 };
}

/** Combined size of the paths in GB; null when `du` did not finish in time. */
export function sizeGb(paths: string[], timeoutMs = 240_000): number | null {
  const existing = paths.filter((entry) => fs.existsSync(entry));
  if (existing.length === 0) return 0;
  const result = spawnSync("du", ["-sk", ...existing], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  // du exits non-zero on unreadable entries but still prints the totals it has.
  if (result.error || !result.stdout) return null;
  let kilobytes = 0;
  for (const line of result.stdout.trim().split("\n"))
    kilobytes += Number(line.split("\t")[0]) || 0;
  return kilobytes / 1024 / 1024;
}

export function hasBinary(name: string): boolean {
  return spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).status === 0;
}

export function dockerRunning(): boolean {
  return (
    spawnSync("docker", ["info"], { encoding: "utf8", timeout: 15_000 })
      .status === 0
  );
}
