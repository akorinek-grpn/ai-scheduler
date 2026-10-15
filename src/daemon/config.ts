import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";

import yaml from "js-yaml";

import {
  configSchema,
  hostRole,
  jobRunsOnRole,
  type SchedulerConfig,
} from "@shared/config-schema";

interface ConfigSuccess {
  success: true;
  data: SchedulerConfig;
}

interface ConfigError {
  success: false;
  error: string;
}

export type ConfigResult = ConfigSuccess | ConfigError;

export interface LoadConfigOptions {
  /** Host name to look up in `hosts`. Default: AI_SCHEDULER_HOST, else the Mac's LocalHostName, else os.hostname(), without ".local". */
  hostName?: string;
  /** Return every job, not just this host's; `host` is still resolved. For the Hosts overview. */
  keepAllJobs?: boolean;
}

/** The Mac's own name (System Settings > Sharing). os.hostname() follows DHCP/reverse DNS
 * when HostName is unset and came back as "Mac" after a reboot on 2026-10-15, so the daemon
 * refused its config. LocalHostName stays put. Null off macOS or when scutil fails. */
function macLocalHostName(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

export function localHostName(): string {
  return (process.env.AI_SCHEDULER_HOST || macLocalHostName() || os.hostname()).replace(/\.local$/i, "");
}

export function loadConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): ConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read config file: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      success: false,
      error: `Invalid YAML: ${(err as Error).message}`,
    };
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: `Config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    };
  }

  const config: SchedulerConfig = result.data;
  if (!config.hosts || Object.keys(config.hosts).length === 0) {
    return { success: true, data: config };
  }

  // Several Macs share this file: keep only the jobs whose runs_on names this host's role.
  // An undeclared host is an error rather than "run everything", so a stray copy of the
  // daemon never doubles the scheduled work.
  const hostName = options.hostName ?? localHostName();
  const entry = Object.entries(config.hosts).find(
    ([name]) => name.toLowerCase() === hostName.toLowerCase(),
  );
  if (!entry) {
    return {
      success: false,
      error: `This host (${hostName}) is not in 'hosts' (${Object.keys(config.hosts).join(", ")}). Add it with a role, or remove 'hosts' to run every job here.`,
    };
  }
  const role = hostRole(entry[1]);
  const jobs = options.keepAllJobs
    ? config.jobs
    : Object.fromEntries(
        Object.entries(config.jobs).filter(([, job]) => jobRunsOnRole(job, role)),
      );
  return { success: true, data: { ...config, jobs, host: { name: hostName, role } } };
}
