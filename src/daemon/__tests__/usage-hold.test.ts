import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CronEngine } from "../cron-engine";
import { CatchupQueue } from "../catchup";
import { createApp } from "../api";
import * as jobRunner from "../job-runner";
import * as evaluator from "../evaluator";
import { getNewestRunStartedAt, getRunDir } from "@shared/paths";
import { getUsageHoldPath } from "../usage-hold";
import type { SchedulerConfig } from "@shared/config-schema";
import type { UsageLimitHit } from "@shared/types";

// The usage hold (2026-10-16): a run blocked by the account's usage limit holds every job that
// starts a Claude session on this Mac until the reset. Skipped ticks make no run directory, are
// queued under the job's catchup policy and start once the hold ends; scripts without
// `uses_claude` keep running; manual triggers are refused; the hold survives a restart.

type Started = { jobId: string; trigger: string; at: string };

const LIMIT: UsageLimitHit = {
  kind: "weekly",
  resetsAt: "2026-10-16T15:00:00.000Z",
  zone: "Europe/Prague",
  text: "You've hit your weekly limit · resets 5pm (Europe/Prague)",
};

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
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

describe("usage hold", () => {
  let tmpDir: string;
  let started: Started[];
  let outcomes: Array<"limit" | "success">;
  let engine: CronEngine;
  let queue: CatchupQueue;

  const base = { directory: "/tmp", enabled: true, skip_permissions: false, tags: [] as string[] };
  const config: SchedulerConfig = {
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50, priority: "background" },
    jobs: {
      review: { ...base, name: "Review", schedule: "0 * * * *", type: "claude", prompt: "p", catchup: "never" },
      autopilot: { ...base, name: "Autopilot", schedule: "25 * * * *", type: "script", command: "run.sh", uses_claude: true },
      janitor: { ...base, name: "Janitor", schedule: "45 * * * *", type: "script", command: "npm run janitor" },
    },
  };

  const writeRun = (jobId: string, status: "blocked" | "success"): string => {
    const at = new Date();
    const runId = `${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${started.length.toString(16).padStart(6, "0")}`;
    const dir = getRunDir(tmpDir, jobId, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId, runId, trigger: "scheduled", startedAt: at.toISOString(), jobConfig: config.jobs[jobId] }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ status, exitCode: status === "blocked" ? 1 : 0, startedAt: at.toISOString(), finishedAt: at.toISOString() }));
    fs.writeFileSync(path.join(dir, "output.log"), status === "blocked" ? `${LIMIT.text}\n` : "ok\n");
    return runId;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hold-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
    vi.useFakeTimers({ now: new Date("2026-10-16T13:00:00Z") });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    started = [];
    outcomes = [];
    vi.spyOn(jobRunner, "runJob").mockImplementation(async (opts) => {
      const outcome = outcomes.shift() ?? "success";
      started.push({ jobId: opts.jobId, trigger: opts.trigger, at: new Date().toISOString() });
      const runId = writeRun(opts.jobId, outcome === "limit" ? "blocked" : "success");
      return outcome === "limit"
        ? { runId, status: "blocked", exitCode: 1, usageLimit: LIMIT }
        : { runId, status: "success", exitCode: 0 };
    });
    vi.spyOn(evaluator, "evaluateRun").mockResolvedValue(null);
  });

  afterEach(() => {
    engine?.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const wire = () => {
    engine = new CronEngine(tmpDir);
    engine.loadJobs(config);
    // Ticks are driven by hand below; node-cron's own tasks would fire under the fake clock.
    engine.stopAll();
    queue = new CatchupQueue({
      runCatchup: async (id, slot, options) => {
        await engine.runCatchup(id, slot, options);
      },
      isJobActive: (id) => engine.getActiveJobIds().includes(id),
      jobName: (id) => id,
      catchupPolicy: (id) => engine.getCurrentConfig()?.jobs[id]?.catchup,
      newestRunStartedAt: (id) => getNewestRunStartedAt(tmpDir, id),
      holdUntil: (id) => engine.holdUntilMsFor(id),
    });
    engine.setCatchupQueue(queue);
  };
  const tick = (jobId: string, slotIso: string) =>
    (engine as unknown as { executeJob: (id: string, slot: Date) => Promise<void> }).executeJob(jobId, new Date(slotIso));

  it("holds Claude jobs until the reset, lets other scripts run, and releases queued ticks after", async () => {
    wire();
    outcomes = ["limit"];
    await tick("review", "2026-10-16T13:00:00Z");
    expect(started).toHaveLength(1);

    // Rated by the scheduler, no model; the hold is on disk.
    const runDir = path.join(tmpDir, "data", "runs", "review", fs.readdirSync(path.join(tmpDir, "data", "runs", "review")).filter((n) => n !== "latest")[0]);
    const evaluation = JSON.parse(fs.readFileSync(path.join(runDir, "evaluation.json"), "utf8"));
    expect(evaluation).toMatchObject({ severity: "warning", followUpNeeded: false, source: "scheduler" });
    expect(evaluation.summary).toContain("weekly usage limit is exhausted");
    expect(evaluation.summary).toContain("held until 2026-10-16T15:01:00.000Z");
    expect(evaluator.evaluateRun).not.toHaveBeenCalled();
    expect(engine.getUsageHold()).toMatchObject({ kind: "weekly", until: "2026-10-16T15:01:00.000Z", since: "2026-10-16T13:00:00.000Z", skipped: 0, jobId: "review" });
    expect(JSON.parse(fs.readFileSync(getUsageHoldPath(tmpDir), "utf8"))).toMatchObject({ version: 1, kind: "weekly" });

    // The next review tick is skipped: no run, no run directory, counted; catchup: never queues nothing.
    await vi.advanceTimersByTimeAsync(60 * 60_000); // 14:00
    await tick("review", "2026-10-16T14:00:00Z");
    expect(started).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmpDir, "data", "runs", "review")).filter((n) => n !== "latest")).toHaveLength(1);
    expect(engine.getUsageHold()?.skipped).toBe(1);
    expect(queue.snapshot().queued).toEqual([]);

    // A script with uses_claude is skipped and queued (catchup: always); the queue keeps it.
    await vi.advanceTimersByTimeAsync(25 * 60_000); // 14:25
    await tick("autopilot", "2026-10-16T14:25:00Z");
    expect(started).toHaveLength(1);
    expect(queue.snapshot().queued).toEqual([expect.objectContaining({ jobId: "autopilot", kind: "catchup" })]);
    queue.process();
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toHaveLength(1);
    expect(queue.snapshot().queued).toHaveLength(1);

    // A script without it runs as usual; a manual trigger of a held job is refused.
    await vi.advanceTimersByTimeAsync(20 * 60_000); // 14:45
    await tick("janitor", "2026-10-16T14:45:00Z");
    expect(started.at(-1)).toMatchObject({ jobId: "janitor", trigger: "scheduled" });
    expect(await engine.triggerJob("review")).toEqual({ error: expect.stringContaining("held until 2026-10-16T15:01:00.000Z") });
    expect(await engine.triggerJob("janitor")).toHaveProperty("runId");

    // Past the reset: the hold is gone (file too), the queued catch-up runs, new ticks run.
    await vi.advanceTimersByTimeAsync(17 * 60_000); // 15:02
    expect(started.find((s) => s.jobId === "autopilot")).toMatchObject({ trigger: "catchup" });
    expect(engine.getUsageHold()).toBeNull();
    expect(fs.existsSync(getUsageHoldPath(tmpDir))).toBe(false);
    await tick("review", "2026-10-16T16:00:00Z");
    expect(started.at(-1)).toMatchObject({ jobId: "review", trigger: "scheduled" });
  });

  it("a later hit never shortens the hold, and the hold survives a restart", async () => {
    wire();
    outcomes = ["limit"];
    await tick("review", "2026-10-16T13:00:00Z");
    engine.clearUsageHold();
    expect(fs.existsSync(getUsageHoldPath(tmpDir))).toBe(false);
    // A script that is never held can still report the limit (it called claude itself).
    vi.spyOn(jobRunner, "runJob").mockImplementationOnce(async (opts) => {
      started.push({ jobId: opts.jobId, trigger: opts.trigger, at: new Date().toISOString() });
      const runId = writeRun(opts.jobId, "blocked");
      return { runId, status: "blocked", exitCode: 1, usageLimit: { ...LIMIT, kind: "session", resetsAt: "2026-10-16T14:00:00.000Z" } };
    });
    vi.setSystemTime(new Date("2026-10-16T13:45:00Z"));
    await tick("janitor", "2026-10-16T13:45:00Z");
    expect(engine.getUsageHold()).toMatchObject({ kind: "session", until: "2026-10-16T14:01:00.000Z", since: "2026-10-16T13:45:00.000Z" });
    // The weekly hit, later reset: the hold moves out, `since` stays; a hit with an earlier reset changes nothing.
    vi.setSystemTime(new Date("2026-10-16T13:50:00Z"));
    (engine as unknown as { setUsageHold: (hit: UsageLimitHit, jobId: string, runId: string) => void }).setUsageHold(LIMIT, "review", "r2");
    expect(engine.getUsageHold()).toMatchObject({ kind: "weekly", until: "2026-10-16T15:01:00.000Z", since: "2026-10-16T13:45:00.000Z" });
    (engine as unknown as { setUsageHold: (hit: UsageLimitHit, jobId: string, runId: string) => void }).setUsageHold({ ...LIMIT, kind: "session", resetsAt: "2026-10-16T14:30:00.000Z" }, "review", "r3");
    expect(engine.getUsageHold()).toMatchObject({ kind: "weekly", until: "2026-10-16T15:01:00.000Z" });

    // A new daemon on the same data dir starts held; once expired the file is removed on first look.
    engine.stopAll();
    const restarted = new CronEngine(tmpDir);
    restarted.loadJobs(config);
    expect(restarted.getUsageHold()).toMatchObject({ kind: "weekly", until: "2026-10-16T15:01:00.000Z" });
    expect(restarted.holdUntilMsFor("review")).toBe(Date.parse("2026-10-16T15:01:00.000Z"));
    expect(restarted.holdUntilMsFor("janitor")).toBeNull();
    vi.setSystemTime(new Date("2026-10-16T15:02:00Z"));
    expect(restarted.getUsageHold()).toBeNull();
    expect(fs.existsSync(getUsageHoldPath(tmpDir))).toBe(false);
    restarted.stopAll();
  });

  it("shows the hold on /api/health, clears it on request, and serves the gauge's samples", async () => {
    wire();
    const app = createApp(engine, tmpDir, new Date().toISOString());
    expect((await request(app, "GET", "/api/health")).body).toMatchObject({ usageHold: null });
    outcomes = ["limit"];
    await tick("review", "2026-10-16T13:00:00Z");
    expect((await request(app, "GET", "/api/health")).body).toMatchObject({ usageHold: { kind: "weekly", until: "2026-10-16T15:01:00.000Z" } });

    const usageDir = path.join(tmpDir, "data", "usage");
    fs.mkdirSync(usageDir, { recursive: true });
    fs.writeFileSync(path.join(usageDir, "latest.json"), JSON.stringify({ at: "2026-10-16T13:00:00Z", status: "ok", windows: { seven_day: { utilization_percent: 61 } } }));
    fs.writeFileSync(path.join(usageDir, "headroom.jsonl"), ["{\"at\":\"a\"}", "not json", "{\"at\":\"b\"}"].join("\n") + "\n");
    const usage = await request(app, "GET", "/api/usage");
    expect(usage.body).toMatchObject({ latest: { status: "ok" }, samples: [{ at: "a" }, { at: "b" }], hold: { kind: "weekly" } });

    expect((await request(app, "POST", "/api/usage-hold/clear")).body).toEqual({ ok: true, cleared: true });
    expect((await request(app, "GET", "/api/health")).body).toMatchObject({ usageHold: null });
    expect((await request(app, "POST", "/api/usage-hold/clear")).body).toEqual({ ok: true, cleared: false });
    expect(await engine.triggerJob("review")).toHaveProperty("runId");
    // No gauge files at all: still a clean answer.
    fs.rmSync(usageDir, { recursive: true, force: true });
    expect((await request(app, "GET", "/api/usage")).body).toEqual({ latest: null, samples: [], hold: null });
  });
});
