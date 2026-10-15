import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import type { JobConfig, RunMeta, RunStatusFile } from "@shared/types";

async function request(
  app: ReturnType<typeof createApp>,
  url: string,
): Promise<{ status: number; body: unknown }> {
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
            let body: unknown = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              // keep raw text
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const job: JobConfig = {
  name: "Job",
  schedule: "0 9 * * *",
  directory: "/tmp",
  type: "claude",
  prompt: "hello",
  enabled: true,
  skip_permissions: false,
  tags: [],
};

const yamlJob = (runsOn: string) => `
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
    runs_on: ${runsOn}
`;

describe("GET /api/runs?scope= (several Macs, one file)", () => {
  let tmpDir: string;
  let engine: CronEngine;
  let savedHost: string | undefined;

  function writeRun(jobId: string, runId: string, startedAt: string): void {
    const runDir = path.join(tmpDir, "data", "runs", jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = { jobId, runId, jobConfig: job, trigger: "scheduled", startedAt };
    const status: RunStatusFile = { status: "success", exitCode: 0, startedAt, finishedAt: startedAt };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
  }

  const jobIds = (body: unknown): string[] =>
    (body as { jobId: string }[]).map((run) => run.jobId).sort();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-scope-"));
    engine = new CronEngine(tmpDir);
    savedHost = process.env.AI_SCHEDULER_HOST;
    process.env.AI_SCHEDULER_HOST = "AIR-1";
    // One run each: a job placed here, one placed on the other Mac, one for everywhere,
    // and one the file no longer names (history of a removed job).
    writeRun("reviews", "r-1", "2026-10-15T09:00:00.000Z");
    writeRun("summaries", "s-1", "2026-10-15T09:05:00.000Z");
    writeRun("janitor", "j-1", "2026-10-15T09:10:00.000Z");
    writeRun("retired", "x-1", "2026-10-15T09:15:00.000Z");
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedHost === undefined) delete process.env.AI_SCHEDULER_HOST;
    else process.env.AI_SCHEDULER_HOST = savedHost;
  });

  function writeHostsConfig(): void {
    fs.writeFileSync(
      path.join(tmpDir, "scheduler.yaml"),
      `version: 1
hosts:
  LAPTOP-1: groupon-mac-16
  AIR-1: groupon-mac-air
jobs:
  reviews:
    name: Reviews${yamlJob("groupon-mac-air")}
  summaries:
    name: Summaries${yamlJob("groupon-mac-16")}
  janitor:
    name: Janitor${yamlJob("all")}
`,
    );
  }

  it("hides runs of jobs placed on another host by default, keeps unknown jobs", async () => {
    writeHostsConfig();
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "/api/runs");
    expect(res.status).toBe(200);
    expect(jobIds(res.body)).toEqual(["janitor", "retired", "reviews"]);
    expect(jobIds((await request(app, "/api/runs?scope=host")).body)).toEqual([
      "janitor", "retired", "reviews",
    ]);
  });

  it("returns every run with scope=all", async () => {
    writeHostsConfig();
    const app = createApp(engine, tmpDir, new Date().toISOString());
    expect(jobIds((await request(app, "/api/runs?scope=all")).body)).toEqual([
      "janitor", "retired", "reviews", "summaries",
    ]);
  });

  it("follows a placement change without a restart", async () => {
    writeHostsConfig();
    const app = createApp(engine, tmpDir, new Date().toISOString());
    expect(jobIds((await request(app, "/api/runs")).body)).not.toContain("summaries");
    // Move summaries here; the file's mtime changes, so the cache is refreshed.
    const file = path.join(tmpDir, "scheduler.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("runs_on: groupon-mac-16", "runs_on: all"));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    expect(jobIds((await request(app, "/api/runs")).body)).toContain("summaries");
  });

  it("hides nothing on a single-machine config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "scheduler.yaml"),
      `version: 1
jobs:
  reviews:
    name: Reviews
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
`,
    );
    const app = createApp(engine, tmpDir, new Date().toISOString());
    expect(jobIds((await request(app, "/api/runs")).body)).toHaveLength(4);
  });

  it("rejects an unknown scope", async () => {
    writeHostsConfig();
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "/api/runs?scope=everywhere");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringContaining("scope") });
  });
});
