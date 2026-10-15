import { execFile } from "child_process";
import fs from "fs";
import path from "path";

import { hostSsh, type SchedulerConfig } from "@shared/config-schema";

/**
 * Run data each daemon shares with the other hosts in scheduler.yaml (2026-10-15). A host that
 * can reach another over ssh pulls that host's data into data/hosts/<name>/data/ and pushes its
 * own into the other host's data/hosts/<self>/data/, so both web UIs can show both. Hosts are
 * assumed to keep the scheduler at the same absolute path. One-way reachability is enough: the
 * reachable side does both directions.
 */
export const SYNCED_DATA_DIRS = ["runs", "activity", "research"] as const;

export function hostMirrorRoot(projectRoot: string, hostName: string): string {
  return path.join(projectRoot, "data", "hosts", hostName);
}

export interface SyncStep {
  cmd: string;
  args: string[];
}

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export function hostSyncSteps(
  projectRoot: string,
  selfName: string,
  target: { name: string; ssh: string },
  rsyncBin: string,
): SyncStep[] {
  const ownData = path.join(projectRoot, "data");
  const mirrorData = path.join(hostMirrorRoot(projectRoot, target.name), "data");
  // Same layout on the other host: its inbox for our data, and its own data dirs.
  const remoteInbox = path.join(projectRoot, "data", "hosts", selfName, "data");
  const rsync = (from: string, to: string): SyncStep => ({
    cmd: rsyncBin,
    args: ["-a", "--delete", "--timeout=60", "-e", `ssh ${SSH_OPTIONS.join(" ")}`, from, to],
  });
  const steps: SyncStep[] = [
    {
      cmd: "/usr/bin/ssh",
      args: [
        ...SSH_OPTIONS,
        target.ssh,
        `mkdir -p ${SYNCED_DATA_DIRS.flatMap((d) => [`${ownData}/${d}`, `${remoteInbox}/${d}`]).join(" ")}`,
      ],
    },
  ];
  for (const dir of SYNCED_DATA_DIRS) {
    steps.push(rsync(`${target.ssh}:${ownData}/${dir}/`, `${mirrorData}/${dir}/`));
    steps.push(rsync(`${ownData}/${dir}/`, `${target.ssh}:${remoteInbox}/${dir}/`));
  }
  return steps;
}

export type StepRunner = (step: SyncStep) => Promise<void>;

const execRunner: StepRunner = (step) =>
  new Promise((resolve, reject) => {
    execFile(step.cmd, step.args, { timeout: 120_000 }, (err, _stdout, stderr) => {
      // rsync 24: files vanished mid-copy (a run was pruned); the next sync settles it.
      if (err && (err as NodeJS.ErrnoException & { code?: number }).code !== 24) {
        reject(new Error(stderr.trim().split("\n").pop() || err.message));
        return;
      }
      resolve();
    });
  });

export interface HostSyncOptions {
  projectRoot: string;
  getConfig: () => SchedulerConfig | null;
  intervalMs?: number;
  initialDelayMs?: number;
  run?: StepRunner;
  log?: (message: string) => void;
}

export interface HostSync {
  /** One pass over every reachable host; resolves when done. Skipped while a pass runs. */
  syncNow: () => Promise<void>;
  stop: () => void;
}

export function startHostSync(options: HostSyncOptions): HostSync {
  const {
    projectRoot,
    getConfig,
    intervalMs = 5 * 60_000,
    initialDelayMs = 20_000,
    run = execRunner,
    log = (message) => console.log(message),
  } = options;
  const rsyncBin = fs.existsSync("/opt/homebrew/bin/rsync") ? "/opt/homebrew/bin/rsync" : "rsync";
  let running = false;

  const syncNow = async (): Promise<void> => {
    if (running) return;
    const config = getConfig();
    if (!config?.host || !config.hosts) return;
    const self = config.host.name.toLowerCase();
    const targets = Object.entries(config.hosts)
      .filter(([name, entry]) => name.toLowerCase() !== self && hostSsh(entry))
      .map(([name, entry]) => ({ name, ssh: hostSsh(entry) as string }));
    if (targets.length === 0) return;
    running = true;
    try {
      for (const target of targets) {
        const started = Date.now();
        fs.mkdirSync(path.join(hostMirrorRoot(projectRoot, target.name), "data"), { recursive: true });
        try {
          for (const step of hostSyncSteps(projectRoot, config.host.name, target, rsyncBin)) {
            await run(step);
          }
          log(`[hosts] synced ${target.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        } catch (err) {
          log(`[hosts] sync with ${target.name} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void syncNow(), initialDelayMs);
  const interval = setInterval(() => void syncNow(), intervalMs);
  return {
    syncNow,
    stop: () => {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
