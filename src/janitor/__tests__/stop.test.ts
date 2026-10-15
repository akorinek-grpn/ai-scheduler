import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { processStart, stopProcesses } from "../stop";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/** A detached shell with children, like a dev server left behind by a closed session. */
function startTree(script: string): Promise<number> {
  const child = spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  child.unref();
  return new Promise((resolve) =>
    setTimeout(() => resolve(child.pid as number), 300),
  );
}

const descendants = (pid: number): number[] => {
  const rows = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const walk = (parent: number) => {
    for (const [child, ppid] of rows)
      if (ppid === parent) {
        walk(child);
        found.push(child);
      }
  };
  walk(pid);
  return found;
};
/** Running, not merely an exited child this test process has not reaped yet (a zombie). */
const alive = (pid: number): boolean => {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
};
const identities = (pids: number[]) =>
  pids.map((pid) => ({ pid, startedAt: processStart(pid) as string }));

describe("stopping a process tree", () => {
  it("terminates every process of the tree and reports it stopped", async () => {
    const root = await startTree("sleep 300 & sleep 300 & wait");
    const pids = [...descendants(root), root];
    expect(pids.length).toBeGreaterThanOrEqual(3);
    const result = await stopProcesses(identities(pids), { graceMs: 3000 });
    expect(result).toMatchObject({
      stopped: true,
      forced: [],
      survivors: [],
      skipped: [],
    });
    expect(pids.filter(alive)).toEqual([]);
  });

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const root = await startTree('trap "" TERM; while :; do sleep 1; done');
    const result = await stopProcesses(identities([root]), { graceMs: 1000 });
    expect(result.stopped).toBe(true);
    expect(result.forced).toEqual([root]);
    expect(alive(root)).toBe(false);
  });

  it("refuses to signal a pid that is no longer the process it planned to stop", async () => {
    const root = await startTree("sleep 300");
    const result = await stopProcesses(
      [{ pid: root, startedAt: "Thu Jan  1 00:00:00 1970" }],
      { graceMs: 500 },
    );
    expect(result).toMatchObject({ stopped: false, skipped: [root] });
    expect(alive(root)).toBe(true);
  });
});
