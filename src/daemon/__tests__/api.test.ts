import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import fs from "fs";
import path from "path";
import os from "os";
import type { SchedulerConfig } from "@shared/config-schema";
import type { RunStatusFile, RunMeta } from "@shared/types";

async function request(app: ReturnType<typeof createApp>, method: string, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${port}${url}`, { method })
        .then(async (res) => {
          const body = await res.json();
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

describe("daemon API", () => {
  let tmpDir: string;
  let engine: CronEngine;

  const config: SchedulerConfig = {
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50 },
    jobs: {
      "test-job": {
        name: "Test Job",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: true,
        tags: ["daily"],
      },
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-api-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs", "test-job"), { recursive: true });
    engine = new CronEngine(tmpDir);
    engine.loadJobs(config);
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/health returns daemon status", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("running");
    expect(body.pid).toBe(process.pid);
  });

  it("GET /api/jobs returns job list", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>).id).toBe("test-job");
  });

  it("GET /api/runs returns empty list when no runs", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/runs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/runs returns runs from data directory", async () => {
    const runDir = path.join(tmpDir, "data", "runs", "test-job", "2026-04-08T09-00-00-abc123");
    fs.mkdirSync(runDir, { recursive: true });

    const meta: RunMeta = {
      jobId: "test-job",
      runId: "2026-04-08T09-00-00-abc123",
      jobConfig: config.jobs["test-job"],
      trigger: "scheduled",
      startedAt: "2026-04-08T09:00:00.000Z",
    };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));

    const status: RunStatusFile = {
      status: "success",
      exitCode: 0,
      startedAt: "2026-04-08T09:00:00.000Z",
      finishedAt: "2026-04-08T09:03:00.000Z",
    };
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
    fs.writeFileSync(path.join(runDir, "output.log"), "some output");

    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/runs");
    expect(res.status).toBe(200);
    const runs = res.body as Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("test-job");
    expect(runs[0].status).toBe("success");
  });

  describe("GET /api/stats/activity", () => {
    it("returns lifetime + daily stats with default 30-day window", async () => {
      const app = createApp(engine, tmpDir, new Date().toISOString());
      const res = await request(app, "GET", "/api/stats/activity");

      expect(res.status).toBe(200);
      const body = res.body as { lifetime: { sessions: number; toolCalls: number; toolsByName: Record<string, number> }; daily: Array<{ date: string; sessions: number; toolCalls: number }> };
      expect(body.lifetime).toBeDefined();
      expect(body.lifetime.sessions).toBe(0);
      expect(Array.isArray(body.daily)).toBe(true);
      expect(body.daily.length).toBe(30);
    });

    it("respects ?days= query param (clamped to 1..90)", async () => {
      const app = createApp(engine, tmpDir, new Date().toISOString());

      const seven = await request(app, "GET", "/api/stats/activity?days=7");
      expect((seven.body as { daily: unknown[] }).daily.length).toBe(7);

      const tooMany = await request(app, "GET", "/api/stats/activity?days=500");
      expect((tooMany.body as { daily: unknown[] }).daily.length).toBe(90);

      const zero = await request(app, "GET", "/api/stats/activity?days=0");
      expect((zero.body as { daily: unknown[] }).daily.length).toBe(1);
    });
  });

  describe("GET /api/queue/catchups", () => {
    it("returns an empty snapshot when no catch-up queue is set", async () => {
      const app = createApp(engine, tmpDir, new Date().toISOString());
      const res = await request(app, "GET", "/api/queue/catchups");
      expect(res.status).toBe(200);
      const body = res.body as { queued: unknown[]; inFlight: unknown };
      expect(body.queued).toEqual([]);
      expect(body.inFlight).toBeNull();
    });
  });
});
