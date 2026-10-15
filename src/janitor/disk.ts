/**
 * Disk side of the janitor: the janitor.yaml loader, the cache cleaners and directory expiry.
 *
 * Caches are only ever cleaned by their own tool (`uv cache prune`, `pnpm store prune`, ...), which
 * knows what is still referenced. Directory expiry is for caches without such a tool, like the
 * pr-review skill's per-PR checkouts, and removes whole entries nothing touched for N days.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  DEFAULT_JANITOR_CONFIG,
  type ExpireRule,
  type JanitorConfig,
} from "./processes";

const fileSchema = z
  .object({
    min_age_minutes: z.number().positive().optional(),
    max_cpu_seconds_per_hour: z.number().nonnegative().optional(),
    min_observation_gap_minutes: z.number().positive().optional(),
    kill: z
      .object({
        dev_servers: z.boolean().optional(),
        mcp_servers: z.boolean().optional(),
      })
      .strict()
      .optional(),
    protect: z
      .object({
        commands: z.array(z.string().min(1)).optional(),
        ports: z.array(z.number().int().min(1).max(65535)).optional(),
        directories: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    disk: z
      .object({
        uv_cache_prune: z.boolean().optional(),
        pnpm_store_prune: z.boolean().optional(),
        npm_cache_verify: z.boolean().optional(),
        docker_prune: z.boolean().optional(),
        expire: z
          .array(
            z
              .object({
                path: z.string().min(1),
                depth: z.number().int().min(1).max(8),
                max_age_days: z.number().positive(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const expandHome = (value: string): string =>
  value === "~" || value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;

/**
 * janitor.yaml over the defaults. A missing file means the defaults; a file that does not validate
 * throws, because guessing at a protect list is how the wrong process gets stopped.
 */
export function loadJanitorConfig(file: string): JanitorConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return DEFAULT_JANITOR_CONFIG;
  }
  const parsed = fileSchema.safeParse(yaml.load(text) ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${path.basename(file)}: ${issue.path.join(".") || "file"}: ${issue.message}`,
    );
  }
  const data = parsed.data;
  for (const pattern of data.protect?.commands ?? []) {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(
        `${path.basename(file)}: protect.commands: "${pattern}" is not a valid regular expression`,
      );
    }
  }
  const defaults = DEFAULT_JANITOR_CONFIG;
  return {
    minAgeMinutes: data.min_age_minutes ?? defaults.minAgeMinutes,
    maxCpuSecondsPerHour:
      data.max_cpu_seconds_per_hour ?? defaults.maxCpuSecondsPerHour,
    minObservationGapMinutes:
      data.min_observation_gap_minutes ?? defaults.minObservationGapMinutes,
    kill: {
      devServers: data.kill?.dev_servers ?? defaults.kill.devServers,
      mcpServers: data.kill?.mcp_servers ?? defaults.kill.mcpServers,
    },
    protect: {
      // Added to the built-in protections, never replacing them.
      commands: [
        ...defaults.protect.commands,
        ...(data.protect?.commands ?? []),
      ],
      ports: data.protect?.ports ?? defaults.protect.ports,
      directories: (
        data.protect?.directories ?? defaults.protect.directories
      ).map(expandHome),
    },
    disk: {
      uvCachePrune: data.disk?.uv_cache_prune ?? defaults.disk.uvCachePrune,
      pnpmStorePrune:
        data.disk?.pnpm_store_prune ?? defaults.disk.pnpmStorePrune,
      npmCacheVerify:
        data.disk?.npm_cache_verify ?? defaults.disk.npmCacheVerify,
      dockerPrune: data.disk?.docker_prune ?? defaults.disk.dockerPrune,
      expire: data.disk?.expire
        ? data.disk.expire.map((rule) => ({
            path: expandHome(rule.path),
            depth: rule.depth,
            maxAgeDays: rule.max_age_days,
          }))
        : defaults.disk.expire,
    },
  };
}

export interface CleanerCommand {
  id: "uv" | "pnpm" | "npm" | "docker";
  label: string;
  argv: string[];
  /** Directory whose size the report shows for this cleaner, when it has one. */
  sizePath: string | null;
}

/** The cleaner commands to run, in order: enabled in the config, tool installed, Docker running. */
export function cleanerCommands(
  disk: JanitorConfig["disk"],
  has: (binary: string) => boolean,
  dockerRunning: () => boolean,
): CleanerCommand[] {
  const home = os.homedir();
  const commands: CleanerCommand[] = [];
  if (disk.uvCachePrune && has("uv"))
    commands.push({
      id: "uv",
      label: "uv package cache",
      argv: ["uv", "cache", "prune"],
      sizePath: path.join(home, ".cache/uv"),
    });
  if (disk.pnpmStorePrune && has("pnpm"))
    commands.push({
      id: "pnpm",
      label: "pnpm store",
      argv: ["pnpm", "store", "prune"],
      sizePath: path.join(home, "Library/pnpm"),
    });
  if (disk.npmCacheVerify && has("npm"))
    commands.push({
      id: "npm",
      label: "npm cache",
      argv: ["npm", "cache", "verify"],
      sizePath: path.join(home, ".npm"),
    });
  if (disk.dockerPrune && has("docker") && dockerRunning())
    commands.push(
      {
        id: "docker",
        label: "Docker dangling images",
        argv: ["docker", "image", "prune", "-f"],
        sizePath: null,
      },
      {
        id: "docker",
        label: "Docker build cache older than 7 days",
        argv: ["docker", "builder", "prune", "-f", "--filter", "until=168h"],
        sizePath: null,
      },
    );
  return commands;
}

export interface ExpiredEntry {
  path: string;
  ageDays: number;
  removed: boolean;
}

function directoriesAtDepth(base: string, depth: number): string[] {
  let level = [base];
  for (let step = 0; step < depth; step++) {
    const next: string[] = [];
    for (const directory of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries)
        if (entry.isDirectory()) next.push(path.join(directory, entry.name));
    }
    level = next;
  }
  return level.sort();
}

/** Newest modification among the directory and its immediate entries: a checkout in use shows there. */
function lastTouched(directory: string): number {
  let newest = fs.statSync(directory).mtimeMs;
  for (const name of fs.readdirSync(directory)) {
    try {
      newest = Math.max(
        newest,
        fs.lstatSync(path.join(directory, name)).mtimeMs,
      );
    } catch {
      // vanished while listing
    }
  }
  return newest;
}

/** Entries of the rule older than its limit; with `apply` they are deleted, otherwise only listed. */
export function expireDirectories(
  rule: ExpireRule,
  now: Date,
  apply: boolean,
): ExpiredEntry[] {
  const expired: ExpiredEntry[] = [];
  for (const directory of directoriesAtDepth(rule.path, rule.depth)) {
    let ageDays: number;
    try {
      ageDays = (now.getTime() - lastTouched(directory)) / 86_400_000;
    } catch {
      continue;
    }
    if (ageDays <= rule.maxAgeDays) continue;
    let removed = false;
    if (apply) {
      fs.rmSync(directory, { recursive: true, force: true });
      removed = !fs.existsSync(directory);
    }
    expired.push({ path: directory, ageDays, removed });
  }
  return expired;
}
