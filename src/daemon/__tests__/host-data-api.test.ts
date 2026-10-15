import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import { loadConfig } from "../config";
import type { ActivityStatsResponse } from "@shared/types";
import type { CostStatsResponse } from "@shared/cost-types";

async function get(app: ReturnType<typeof createApp>, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      http
        .get({ host: "127.0.0.1", port, path: url }, (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (raw += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const yamlJob = (runsOn: string) => `
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
    runs_on: ${runsOn}
`;

const CONFIG = `version: 1
hosts:
  PRO-1: pro
  AIR-1: { role: air, ssh: desk }
jobs:
  summaries:
    name: Summaries${yamlJob("pro")}
  reviews:
    name: Reviews${yamlJob("air")}
  janitor:
    name: Janitor${yamlJob("all")}
`;

describe("one UI over several hosts' data", () => {
  let tmpDir: string;
  let mirror: string;
  let engine: CronEngine;
  let app: ReturnType<typeof createApp>;
  let savedHost: string | undefined;

  const today = new Date().toISOString().slice(0, 10);

  /** A completed AI run with 2 tool calls; `host` is the stamp in meta.json. */
  function writeRun(root: string, jobId: string, runId: string, host: string | undefined, preserve = false): void {
    const startedAt = `${today}T0${runId.length % 8}:00:00.000Z`;
    const dir = path.join(root, "data", "runs", jobId, runId);
    fs.mkdirSync(dir, { recursive: true });
    const jobConfig = { name: jobId, schedule: "0 9 * * *", directory: "/tmp", type: "claude", prompt: "go", enabled: true, skip_permissions: false, tags: [] };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId, runId, jobConfig, trigger: "scheduled", startedAt, ...(host ? { host } : {}) }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ status: "success", exitCode: 0, startedAt, finishedAt: startedAt }));
    const stats = { toolCalls: 2, toolsByName: { Bash: 2 }, isAiSession: true, finalized: true };
    fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify(stats));
    if (preserve) {
      // What the other host's daemon preserved, as it arrives through the mirror.
      const activityDir = path.join(root, "data", "activity", jobId);
      fs.mkdirSync(activityDir, { recursive: true });
      fs.writeFileSync(
        path.join(activityDir, `${runId}.json`),
        JSON.stringify({ version: 1, jobId, runId, startedAt, stats, ...(host ? { host } : {}) }),
      );
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hostdata-"));
    mirror = path.join(tmpDir, "data", "hosts", "AIR-1");
    fs.writeFileSync(path.join(tmpDir, "scheduler.yaml"), CONFIG);
    savedHost = process.env.AI_SCHEDULER_HOST;
    process.env.AI_SCHEDULER_HOST = "PRO-1";

    // This host: an unstamped run (ours by default), a stamped one, and a pre-split run of a
    // job that has since moved to the Air.
    writeRun(tmpDir, "summaries", "s-1", undefined);
    writeRun(tmpDir, "janitor", "j-pro", "PRO-1");
    writeRun(tmpDir, "reviews", "r-old", "PRO-1");
    // The Air's mirror: its own runs, plus a copy of our s-1 it received before the split.
    writeRun(mirror, "reviews", "r-air", "AIR-1", true);
    writeRun(mirror, "janitor", "j-air", "AIR-1", true);
    writeRun(mirror, "summaries", "s-1", "PRO-1", true);

    const loaded = loadConfig(path.join(tmpDir, "scheduler.yaml"));
    if (!loaded.success) throw new Error(loaded.error);
    engine = new CronEngine(tmpDir);
    engine.loadJobs(loaded.data);
    app = createApp(engine, tmpDir, new Date().toISOString());
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedHost === undefined) delete process.env.AI_SCHEDULER_HOST;
    else process.env.AI_SCHEDULER_HOST = savedHost;
  });

  const ids = (body: unknown) =>
    (body as { jobId: string; runId: string; host?: string }[]).map((r) => `${r.host}:${r.jobId}/${r.runId}`).sort();

  it("lists this host's runs by default, tagged, without jobs placed elsewhere", async () => {
    const res = await get(app, "/api/runs");
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(["PRO-1:janitor/j-pro", "PRO-1:summaries/s-1"]);
  });

  it("lists another host's own runs from its mirror, never our copied history", async () => {
    const res = await get(app, "/api/runs?host=air-1");
    expect(ids(res.body)).toEqual(["AIR-1:janitor/j-air", "AIR-1:reviews/r-air"]);
  });

  it("lists every host's runs once with host=all", async () => {
    const res = await get(app, "/api/runs?host=all");
    expect(ids(res.body)).toEqual([
      "AIR-1:janitor/j-air",
      "AIR-1:reviews/r-air",
      "PRO-1:janitor/j-pro",
      "PRO-1:reviews/r-old",
      "PRO-1:summaries/s-1",
    ]);
  });

  it("limits runs to a start-time window with since and until", async () => {
    // s-1 starts at 03:00 UTC, every other run at 05:00 UTC.
    const since = await get(app, `/api/runs?host=all&since=${today}T04:00:00.000Z`);
    expect(ids(since.body)).not.toContain("PRO-1:summaries/s-1");
    expect(ids(since.body)).toHaveLength(4);
    const until = await get(app, `/api/runs?host=all&until=${today}T04:00:00.000Z`);
    expect(ids(until.body)).toEqual(["PRO-1:summaries/s-1"]);
    expect((await get(app, "/api/runs?since=yesterday")).status).toBe(400);
  });

  it("reads a run from the host that ran it", async () => {
    expect((await get(app, "/api/runs/reviews/r-air?host=AIR-1")).body).toMatchObject({ host: "AIR-1", runId: "r-air" });
    expect((await get(app, "/api/runs/reviews/r-air")).status).toBe(404);
    expect((await get(app, "/api/runs/reviews/r-air?host=NOPE")).status).toBe(400);
  });

  it("splits activity per host and counts a copied run once", async () => {
    const body = (await get(app, "/api/stats/activity?days=7")).body as ActivityStatsResponse;
    const byHost = Object.fromEntries((body.hosts ?? []).map((h) => [h.name, h.lifetime.sessions]));
    expect(byHost).toEqual({ "PRO-1": 3, "AIR-1": 2 });
    expect(body.lifetime.sessions).toBe(5);
    expect(body.hosts?.find((h) => h.name === "PRO-1")?.isSelf).toBe(true);
  });

  it("splits costs per host, with per-host job rows", async () => {
    const body = (await get(app, "/api/stats/costs?days=7")).body as CostStatsResponse;
    expect(body.hosts?.map((h) => [h.name, h.period.runs])).toEqual([["PRO-1", 3], ["AIR-1", 2]]);
    expect(body.period.runs).toBe(5);
    const janitorRows = body.jobs.filter((j) => j.jobId === "janitor").map((j) => j.host).sort();
    expect(janitorRows).toEqual(["AIR-1", "PRO-1"]);
  });

  it("serves another host's jobs read-only", async () => {
    const res = await get(app, "/api/jobs?host=AIR-1");
    const jobs = res.body as { id: string; host: string; readOnly: boolean }[];
    expect(jobs.map((j) => j.id).sort()).toEqual(["janitor", "reviews"]);
    expect(jobs.every((j) => j.host === "AIR-1" && j.readOnly)).toBe(true);
    const own = (await get(app, "/api/jobs")).body as { id: string; readOnly: boolean }[];
    expect(own.map((j) => j.id).sort()).toEqual(["janitor", "summaries"]);
    expect(own.every((j) => j.readOnly === false)).toBe(true);
  });
});
