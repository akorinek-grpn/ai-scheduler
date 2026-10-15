import { execFile } from "child_process";

import {
  hostRole,
  hostSsh,
  jobRunsOnRole,
  type SchedulerConfig,
} from "@shared/config-schema";

/** What /api/health returns, here or on another host. */
export interface DaemonHealthSnapshot {
  status: string;
  pid: number;
  startedAt: string;
  activeJobs: string[];
  host?: { name: string; role: string } | null;
}

export type HostProbe = (ssh: string) => Promise<DaemonHealthSnapshot>;

export interface HostJobSummary {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  runs_on: string | string[];
}

export interface HostStatus {
  name: string;
  role: string;
  ssh: string | null;
  isSelf: boolean;
  /** null when the host could not be reached; `error` says why. */
  health: DaemonHealthSnapshot | null;
  error: string | null;
  jobs: HostJobSummary[];
}

/** The port every daemon listens on (index.ts DAEMON_PORT). */
const DAEMON_PORT = 3501;

/**
 * Health of another Mac's daemon over `ssh <alias>`, the same channel the setup uses. The
 * daemon binds 127.0.0.1 only, so the probe runs curl on the far side. BatchMode: an unknown
 * host key or a missing key fails fast instead of waiting for a password.
 */
export function sshProbe(ssh: string): Promise<DaemonHealthSnapshot> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        ssh,
        `curl -s --max-time 4 http://127.0.0.1:${DAEMON_PORT}/api/health`,
      ],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim().split("\n")[0] || err.message));
          return;
        }
        if (!stdout.trim()) {
          reject(new Error("host reachable, daemon not answering"));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as DaemonHealthSnapshot);
        } catch {
          reject(new Error("unreadable health response"));
        }
      },
    );
  });
}

/**
 * One entry per declared host: its role, the jobs placed on it (from the full job list, so
 * `all` jobs appear under every host), and its daemon's health - this process for the host
 * we are, a probe for the others. Probes run in parallel; a failed probe becomes `error`.
 */
export async function describeHosts(
  config: SchedulerConfig,
  self: DaemonHealthSnapshot,
  probe: HostProbe = sshProbe,
): Promise<HostStatus[]> {
  const selfName = config.host?.name.toLowerCase();
  return Promise.all(
    Object.entries(config.hosts ?? {}).map(async ([name, entry]) => {
      const role = hostRole(entry);
      const ssh = hostSsh(entry) ?? null;
      const jobs: HostJobSummary[] = Object.entries(config.jobs)
        .filter(([, job]) => jobRunsOnRole(job, role))
        .map(([id, job]) => ({
          id,
          name: job.name,
          schedule: job.schedule,
          enabled: job.enabled,
          runs_on: job.runs_on ?? "all",
        }));
      const base = { name, role, ssh, jobs };
      if (name.toLowerCase() === selfName) {
        return { ...base, isSelf: true, health: self, error: null };
      }
      if (!ssh) {
        return {
          ...base,
          isSelf: false,
          health: null,
          error: "no ssh alias configured for this host",
        };
      }
      try {
        return { ...base, isSelf: false, health: await probe(ssh), error: null };
      } catch (err) {
        return { ...base, isSelf: false, health: null, error: (err as Error).message };
      }
    }),
  );
}
