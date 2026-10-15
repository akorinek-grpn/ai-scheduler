import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { hostSyncSteps, startHostSync, type SyncStep } from "../host-sync";
import type { SchedulerConfig } from "@shared/config-schema";

const ROOT = "/Users/me/ai-scheduler";

describe("hostSyncSteps", () => {
  it("prepares both sides, then pulls their data into the mirror and pushes ours into their inbox", () => {
    const steps = hostSyncSteps(ROOT, "PRO-1", { name: "AIR-1", ssh: "desk" }, "rsync");
    expect(steps[0].cmd).toBe("/usr/bin/ssh");
    expect(steps[0].args).toContain("desk");
    expect(steps[0].args.at(-1)).toContain(`${ROOT}/data/hosts/PRO-1/data/runs`);
    expect(steps[0].args.at(-1)).toContain(`${ROOT}/data/runs`);

    const transfers = steps.slice(1).map((s) => s.args.slice(-2));
    expect(transfers).toContainEqual([`desk:${ROOT}/data/runs/`, `${ROOT}/data/hosts/AIR-1/data/runs/`]);
    expect(transfers).toContainEqual([`${ROOT}/data/runs/`, `desk:${ROOT}/data/hosts/PRO-1/data/runs/`]);
    expect(transfers).toContainEqual([`desk:${ROOT}/data/activity/`, `${ROOT}/data/hosts/AIR-1/data/activity/`]);
    // Mirrors never feed back: only data/runs, data/activity and data/research move, never data/hosts.
    expect(steps.flatMap((s) => s.args).some((a) => /data\/hosts\/[^/]+\/data\/hosts/.test(a))).toBe(false);
    for (const step of steps.slice(1)) {
      expect(step.args.slice(0, 2)).toEqual(["-a", "--delete"]);
      expect(step.args).toContain("ssh -o BatchMode=yes -o ConnectTimeout=10");
    }
  });
});

describe("startHostSync", () => {
  let tmpDir: string;
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = (hosts: SchedulerConfig["hosts"]): SchedulerConfig =>
    ({
      version: 1,
      defaults: { timeout: 300, max_retries: 0, retain_runs: 50, priority: "background" },
      jobs: {},
      hosts,
      host: { name: "PRO-1", role: "pro" },
    }) as SchedulerConfig;

  it("syncs every other host that has an ssh alias, and keeps going past a failing one", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hostsync-"));
    const calls: SyncStep[] = [];
    const logs: string[] = [];
    const sync = startHostSync({
      projectRoot: tmpDir,
      getConfig: () =>
        config({
          "PRO-1": { role: "pro", ssh: "self-alias" },
          "AIR-1": { role: "air", ssh: "desk" },
          "SHELF-1": { role: "shelf", ssh: "shelf" },
          "NAS-1": "nas",
        }),
      initialDelayMs: 60_000,
      intervalMs: 60_000,
      run: async (step) => {
        calls.push(step);
        if (step.args.includes("shelf")) throw new Error("ssh: connect to host shelf: timed out");
      },
      log: (m) => logs.push(m),
    });
    stop = sync.stop;
    await sync.syncNow();

    const aliases = new Set(calls.filter((c) => c.cmd === "/usr/bin/ssh").map((c) => c.args[4]));
    expect(aliases).toEqual(new Set(["desk", "shelf"])); // never itself, never the host without ssh
    expect(logs.some((l) => /synced AIR-1/.test(l))).toBe(true);
    expect(logs.some((l) => /sync with SHELF-1 failed: .*timed out/.test(l))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "data", "hosts", "AIR-1", "data"))).toBe(true);
  });

  it("does nothing on a single-machine config", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hostsync-"));
    const calls: SyncStep[] = [];
    const sync = startHostSync({
      projectRoot: tmpDir,
      getConfig: () => ({ ...config(undefined), host: undefined }) as SchedulerConfig,
      initialDelayMs: 60_000,
      run: async (step) => void calls.push(step),
      log: () => {},
    });
    stop = sync.stop;
    await sync.syncNow();
    expect(calls).toEqual([]);
  });

  it("never overlaps two passes", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hostsync-"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const sync = startHostSync({
      projectRoot: tmpDir,
      getConfig: () => config({ "AIR-1": { role: "air", ssh: "desk" } }),
      initialDelayMs: 60_000,
      run: async () => {
        started++;
        await gate;
      },
      log: () => {},
    });
    stop = sync.stop;
    const first = sync.syncNow();
    await sync.syncNow(); // returns at once: a pass is running
    expect(started).toBe(1);
    release();
    await first;
  });
});
