/**
 * Stops the processes of one planned tree: SIGTERM, a grace period, then SIGKILL for whatever is
 * left. Every signal is preceded by an identity check (pid + start time), so a pid that was reused
 * between planning and stopping is never signalled.
 */
import { spawnSync } from "node:child_process";

export interface StopTarget {
  pid: number;
  startedAt: string;
}

export interface StopResult {
  /** True when every target is gone and none had to be skipped. */
  stopped: boolean;
  /** Pids that needed SIGKILL. */
  forced: number[];
  /** Pids still alive after SIGKILL. */
  survivors: number[];
  /** Pids that are now a different process than the one planned; never signalled. */
  skipped: number[];
}

/** `ps -o lstart` of a live process; null when it is gone or a zombie waiting to be reaped. */
export function processStart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const line = result.stdout.trim();
  if (result.status !== 0 || !line) return null;
  const [state, ...started] = line.split(/\s+/);
  return state.startsWith("Z") ? null : started.join(" ");
}

/** `ps` pads the day of month ("Oct  5"); compare without caring about the padding. */
const sameStart = (left: string, right: string): boolean =>
  left.split(/\s+/).join(" ") === right.split(/\s+/).join(" ");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function stopProcesses(
  targets: StopTarget[],
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<StopResult> {
  const graceMs = options.graceMs ?? 10_000;
  const pollMs = options.pollMs ?? 200;
  const skipped: number[] = [];
  const live: StopTarget[] = [];
  for (const target of targets) {
    const started = processStart(target.pid);
    if (started === null) continue; // already gone
    if (sameStart(started, target.startedAt)) live.push(target);
    else skipped.push(target.pid);
  }
  /** Still the planned process, and still running. */
  const remaining = (): StopTarget[] =>
    live.filter((target) => {
      const started = processStart(target.pid);
      return started !== null && sameStart(started, target.startedAt);
    });
  const signal = (group: StopTarget[], name: NodeJS.Signals): void => {
    for (const target of group) {
      try {
        process.kill(target.pid, name);
      } catch {
        // exited between the check and the signal
      }
    }
  };

  signal(live, "SIGTERM");
  const deadline = Date.now() + graceMs;
  let left = remaining();
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(pollMs);
    left = remaining();
  }
  const forced = left.map((target) => target.pid);
  if (left.length > 0) {
    signal(left, "SIGKILL");
    const killDeadline = Date.now() + 3000;
    while (remaining().length > 0 && Date.now() < killDeadline)
      await sleep(pollMs);
  }
  const survivors = remaining().map((target) => target.pid);
  return {
    stopped: survivors.length === 0 && skipped.length === 0,
    forced,
    survivors,
    skipped,
  };
}
