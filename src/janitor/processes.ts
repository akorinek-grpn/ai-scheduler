/**
 * Which leftover process trees the janitor may stop. Pure: it only reads a snapshot of the machine.
 *
 * "Stale" is never decided by age alone. A tree is a candidate only when all of this holds:
 *  - it hangs directly off launchd and contains no terminal, IDE or Claude session (the session
 *    that started it is gone);
 *  - it is a dev server or an MCP server (nothing else is ever a candidate);
 *  - nothing protects it: the scheduler daemon and this project, launchd-managed services, and the
 *    commands, ports and directories of the protect list;
 *  - it is older than `minAgeMinutes`, was already seen by an earlier run, and used almost no CPU
 *    since (`maxCpuSecondsPerHour`). A detached server somebody still uses keeps burning CPU.
 */
import os from "node:os";
import path from "node:path";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  elapsedSeconds: number;
  cpuSeconds: number;
  rssKb: number;
  command: string;
  /** `ps -o lstart`: with the pid, the identity of this process across runs. */
  startedAt: string;
}

export interface ExpireRule {
  path: string;
  /** Directory levels below `path` at which entries are expired (4 = <a>/<b>/<c>/<entry>). */
  depth: number;
  maxAgeDays: number;
}

export interface JanitorConfig {
  minAgeMinutes: number;
  maxCpuSecondsPerHour: number;
  /** A previous observation younger than this cannot show that a tree is idle. */
  minObservationGapMinutes: number;
  kill: { devServers: boolean; mcpServers: boolean };
  protect: { commands: string[]; ports: number[]; directories: string[] };
  disk: {
    uvCachePrune: boolean;
    pnpmStorePrune: boolean;
    npmCacheVerify: boolean;
    dockerPrune: boolean;
    expire: ExpireRule[];
  };
}

export const DEFAULT_JANITOR_CONFIG: JanitorConfig = {
  minAgeMinutes: 120,
  maxCpuSecondsPerHour: 120,
  minObservationGapMinutes: 30,
  kill: { devServers: true, mcpServers: true },
  protect: {
    // Pilot's memory worker daemonises itself on purpose and keeps an MCP child.
    commands: ["\\.pilot/scripts/worker-service\\.cjs"],
    ports: [],
    directories: [],
  },
  disk: {
    uvCachePrune: true,
    pnpmStorePrune: true,
    npmCacheVerify: true,
    dockerPrune: true,
    // The pr-review skill keeps one checkout per reviewed PR and re-creates it on demand.
    expire: [
      {
        path: path.join(os.homedir(), ".claude/cache/pr-review-worktrees"),
        depth: 4,
        maxAgeDays: 7,
      },
    ],
  },
};

export interface Snapshot {
  now: Date;
  /** Only this user's process trees are considered. */
  uid: number;
  processes: ProcessInfo[];
  /** pid -> TCP ports it listens on. */
  listening: Map<number, number[]>;
  /** Pids launchd runs as a service (`launchctl list`): started on purpose, not orphans. */
  launchdManaged: Set<number>;
  /** pid -> working directory, for the pids it was looked up for. */
  cwd: Map<number, string>;
  /** pid -> physical footprint in MB (includes compressed and swapped memory). */
  footprintMb: Map<number, number>;
  /** The scheduler daemon's pid from data/daemon.json, when it is running. */
  daemonPid: number | null;
  projectRoot: string;
}

export interface JanitorState {
  observedAt: string;
  units: Record<string, { cpuSeconds: number }>;
}

export type UnitKind = "dev-server" | "mcp-server";
export type Verdict = "stop" | "observe" | "busy" | "young" | "protected";

export interface UnitReport {
  /** Root pid plus its start time: stable across runs, safe against pid reuse. */
  key: string;
  rootPid: number;
  /** Every pid of the tree, leaves first. */
  pids: number[];
  identities: { pid: number; startedAt: string }[];
  kind: UnitKind;
  verdict: Verdict;
  reason: string;
  ageMinutes: number;
  cpuSeconds: number;
  /** CPU-seconds per hour since the previous observation; null when there is none to compare. */
  cpuRatePerHour: number | null;
  footprintMb: number;
  ports: number[];
  cwd: string | null;
  command: string;
}

// A tree containing one of these still belongs to somebody: a terminal, a multiplexer, an IDE, or a
// Claude/Codex session (including a scheduled `claude -p` job that outlived a daemon restart).
const SESSION_HOST =
  /Warp\.app|iTerm\.app|Terminal\.app|Ghostty|kitty\.app|Alacritty|WezTerm|\btmux\b|\bscreen\b|\bsshd\b|(?:^|\/)login(?:\s|$)|Visual Studio Code|Code Helper|Cursor\.app|Zed\.app|JetBrains|(?:^|\/)claude(?:\s|$)|\.local\/share\/claude\/|ClaudeCode\.app|(?:^|\/)codex(?:\s|$)/;

const DEV_SERVER =
  /\bnext dev\b|next-server \(v|\bvite(?:\s|$)|\bnx (?:dev|serve)\b|\bwebpack(?:-dev-server| serve)\b|\b(?:astro|nuxt|remix|storybook) dev\b|\b(?:npm|pnpm|yarn|bun) run (?:dev|serve|preview)(?::[\w-]+)?(?:\s|$)/;

const MCP_SERVER = /(?:^|[\s/@_-])mcp(?:[\s/@_.-]|$)|open-websearch|cognee/i;

export const unitKey = (rootPid: number, startedAt: string): string =>
  `${rootPid}@${startedAt}`;

/** `[[DD-]HH:]MM:SS` */
export function parseElapsed(text: string): number {
  const [rest, days] = text.includes("-")
    ? [text.split("-")[1], Number(text.split("-")[0])]
    : [text, 0];
  const parts = rest.split(":").map(Number);
  const [hours, minutes, seconds] =
    parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

/** macOS prints `M:SS.cc` (minutes may exceed 59); other formats print `H:MM:SS`. */
export function parseCpuTime(text: string): number {
  const parts = text.split(":").map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*\S)\s*$/;

/** Rows of `ps -axo pid=,ppid=,pgid=,uid=,etime=,time=,rss=,command=`; `startedAt` is filled in separately. */
export function parsePs(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      elapsedSeconds: parseElapsed(match[5]),
      cpuSeconds: parseCpuTime(match[6]),
      rssKb: Number(match[7]),
      command: match[8],
      startedAt: "",
    });
  }
  return rows;
}

function under(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

/** Why this tree must never be stopped, or null. */
function protection(
  tree: ProcessInfo[],
  kind: UnitKind,
  snapshot: Snapshot,
  config: JanitorConfig,
): string | null {
  const { projectRoot, daemonPid, cwd, listening, launchdManaged } = snapshot;
  for (const process of tree) {
    const directory = cwd.get(process.pid);
    if (
      process.pid === daemonPid ||
      process.command.includes(`${projectRoot}/`) ||
      // A working directory inside the project only counts for a dev server (the web UI). Scheduled
      // jobs run with the project as their cwd, so an MCP server that outlived one inherits it.
      (kind === "dev-server" &&
        directory !== undefined &&
        under(projectRoot, directory))
    )
      return "the scheduler daemon or a process of this project";
  }
  if (launchdManaged.has(tree[tree.length - 1].pid))
    return "a launchd service, started on purpose";
  for (const pattern of config.protect.commands) {
    const expression = new RegExp(pattern);
    if (tree.some((process) => expression.test(process.command)))
      return `protect list: command /${pattern}/`;
  }
  for (const port of config.protect.ports)
    if (tree.some((process) => listening.get(process.pid)?.includes(port)))
      return `protect list: port ${port}`;
  for (const directory of config.protect.directories)
    if (
      tree.some((process) => {
        const working = cwd.get(process.pid);
        return (
          process.command.includes(`${directory}/`) ||
          (working !== undefined && under(directory, working))
        );
      })
    )
      return `protect list: directory ${directory}`;
  return null;
}

/**
 * Detached dev-server and MCP-server trees with a verdict each, sorted by root pid. Trees that
 * are attached to a session, or are neither kind, are not reported at all.
 */
export function planUnits(
  snapshot: Snapshot,
  config: JanitorConfig,
  previous: JanitorState | null,
): UnitReport[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const process of snapshot.processes) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  // Leaves first, root last.
  const subtree = (root: ProcessInfo): ProcessInfo[] => [
    ...(children.get(root.pid) ?? []).flatMap(subtree),
    root,
  ];
  const gapMinutes = previous
    ? (snapshot.now.getTime() - Date.parse(previous.observedAt)) / 60_000
    : 0;
  const comparable =
    previous !== null && gapMinutes >= config.minObservationGapMinutes;

  const units: UnitReport[] = [];
  for (const root of children.get(1) ?? []) {
    if (root.uid !== snapshot.uid) continue;
    const tree = subtree(root);
    if (tree.some((process) => SESSION_HOST.test(process.command))) continue;
    const kind: UnitKind | null = tree.some((process) =>
      DEV_SERVER.test(process.command),
    )
      ? "dev-server"
      : tree.some((process) => MCP_SERVER.test(process.command))
        ? "mcp-server"
        : null;
    if (!kind) continue;
    if (
      kind === "dev-server" ? !config.kill.devServers : !config.kill.mcpServers
    )
      continue;

    const key = unitKey(root.pid, root.startedAt);
    const cpuSeconds = tree.reduce(
      (sum, process) => sum + process.cpuSeconds,
      0,
    );
    const ageMinutes = root.elapsedSeconds / 60;
    const before = comparable ? previous.units[key] : undefined;
    const replaced = before !== undefined && cpuSeconds < before.cpuSeconds;
    const cpuRatePerHour =
      before === undefined || replaced
        ? null
        : (cpuSeconds - before.cpuSeconds) / (gapMinutes / 60);

    let verdict: Verdict;
    let reason: string;
    const guard = protection(tree, kind, snapshot, config);
    if (guard) {
      verdict = "protected";
      reason = guard;
    } else if (ageMinutes < config.minAgeMinutes) {
      verdict = "young";
      reason = `detached for less than ${config.minAgeMinutes} min`;
    } else if (before === undefined) {
      verdict = "observe";
      reason = `first sighting; needs a second observation at least ${config.minObservationGapMinutes} min later`;
    } else if (replaced) {
      verdict = "busy";
      reason = "its processes changed since the last observation";
    } else if ((cpuRatePerHour as number) > config.maxCpuSecondsPerHour) {
      verdict = "busy";
      reason = `still working: ${Math.round(cpuRatePerHour as number)} CPU-seconds per hour (limit ${config.maxCpuSecondsPerHour})`;
    } else {
      verdict = "stop";
      reason = `detached and idle: ${Math.round(cpuRatePerHour as number)} CPU-seconds per hour over ${Math.round(gapMinutes)} min`;
    }

    units.push({
      key,
      rootPid: root.pid,
      pids: tree.map((process) => process.pid),
      identities: tree.map(({ pid, startedAt }) => ({ pid, startedAt })),
      kind,
      verdict,
      reason,
      ageMinutes,
      cpuSeconds,
      cpuRatePerHour,
      footprintMb: Math.round(
        tree.reduce(
          (sum, process) =>
            sum +
            (snapshot.footprintMb.get(process.pid) ?? process.rssKb / 1024),
          0,
        ),
      ),
      ports: [
        ...new Set(
          tree.flatMap((process) => snapshot.listening.get(process.pid) ?? []),
        ),
      ].sort((left, right) => left - right),
      cwd:
        snapshot.cwd.get(root.pid) ??
        tree.map((process) => snapshot.cwd.get(process.pid)).find(Boolean) ??
        null,
      command: root.command,
    });
  }
  return units.sort((left, right) => left.rootPid - right.rootPid);
}

/** What the next run compares against. */
export function nextState(now: Date, units: UnitReport[]): JanitorState {
  return {
    observedAt: now.toISOString(),
    units: Object.fromEntries(
      units.map((unit) => [unit.key, { cpuSeconds: unit.cpuSeconds }]),
    ),
  };
}
