import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import { CatchupQueue } from "../catchup";
import * as jobRunner from "../job-runner";
import * as evaluator from "../evaluator";
import type { SchedulerConfig } from "@shared/config-schema";

// POST /api/drain (2026-10-16): the daemon starts no new run, answers with the running jobs, and
// calls its drained handler (index.ts exits for launchd to restart it) once none is left. Until
// then a deploy had to wait for an idle moment or kill a run.

async function request(app: ReturnType<typeof createApp>, method: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${port}${url}`, { method })
        .then(async (res) => {
          const body = (await res.json()) as Record<string, unknown>;
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 500, body: { error: err.message } });
        });
    });
  });
}

describe("drain", () => {
  let tmpDir: string;
  let engine: CronEngine;
  const config: SchedulerConfig = {
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50, priority: "background" },
    jobs: {
      long: { name: "Long", schedule: "0 * * * *", directory: "/tmp", type: "script", command: "true", enabled: true, skip_permissions: false, tags: [] },
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-drain-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
    engine = new CronEngine(tmpDir);
    engine.loadJobs(config);
  });
  afterEach(() => {
    engine.stopAll();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stops new runs, reports the running one, and fires the drained handler when it ends", async () => {
    let finish!: () => void;
    vi.spyOn(jobRunner, "runJob").mockImplementationOnce(async () => {
      await new Promise<void>((r) => (finish = r));
      return { runId: "r1", status: "success", exitCode: 0 };
    });
    const drained = vi.fn();
    engine.onDrained(drained);
    const app = createApp(engine, tmpDir, new Date().toISOString());

    const running = engine.triggerJob("long");
    await new Promise((r) => setTimeout(r, 10));
    expect((await request(app, "GET", "/api/health")).body).toMatchObject({ activeJobs: ["long"], draining: false });

    const res = await request(app, "POST", "/api/drain");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, draining: true, running: ["long"] });
    expect(engine.getRegisteredJobIds()).toEqual([]); // cron tasks stopped
    expect((await request(app, "GET", "/api/health")).body).toMatchObject({ draining: true });
    expect(await engine.triggerJob("long")).toEqual({ error: "Job already running: long" });
    expect(drained).not.toHaveBeenCalled();

    // A reload during the drain schedules nothing new either.
    engine.loadJobs(config);
    expect(engine.getRegisteredJobIds()).toEqual([]);

    finish();
    await running;
    expect(drained).toHaveBeenCalledTimes(1);
    expect(await engine.triggerJob("long")).toEqual({ error: "The daemon is draining; no new runs start until it restarts" });
    expect(await engine.runCatchup("long", new Date())).toEqual({ error: "The daemon is draining" });
  });

  it("fires the drained handler at once when nothing runs, and pauses the catch-up queue", async () => {
    const drained = vi.fn();
    engine.onDrained(drained);
    const queue = new CatchupQueue({
      runCatchup: async () => {},
      isJobActive: () => false,
      jobName: (id) => id,
    });
    engine.setCatchupQueue(queue);
    expect(engine.drain()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(drained).toHaveBeenCalledTimes(1);
    expect(queue.isPaused()).toBe(true);
    expect(queue.enqueue("long", new Date("2026-10-16T12:00:00Z"))).toBe(true);
    queue.process();
    expect(queue.snapshot().inFlight).toBeNull();
    expect(queue.snapshot().queued).toHaveLength(1);
  });
});
