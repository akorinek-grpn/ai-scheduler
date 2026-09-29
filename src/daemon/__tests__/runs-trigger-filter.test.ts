import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import type {
  JobConfig,
  RunMeta,
  RunStatus,
  RunStatusFile,
  TriggerType,
} from "@shared/types";

// Same helper as run-graph-api.test.ts: node:http sends the query string as-is.
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
              // not JSON - keep the raw text
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
  name: "Daily Check",
  schedule: "0 9 * * *",
  directory: "/tmp",
  type: "claude",
  prompt: "hello",
  enabled: true,
  skip_permissions: false,
  tags: [],
};

interface ListedRun {
  jobId: string;
  runId: string;
  trigger: TriggerType;
  status: RunStatus;
  catchupFor?: string;
}

describe("GET /api/runs?trigger=", () => {
  let tmpDir: string;
  let engine: CronEngine;
  let app: ReturnType<typeof createApp>;

  function writeRun(
    jobId: string,
    runId: string,
    trigger: TriggerType,
    startedAt: string,
    options: { status?: RunStatus; catchupFor?: string } = {},
  ): void {
    const runDir = path.join(tmpDir, "data", "runs", jobId, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = {
      jobId,
      runId,
      jobConfig: job,
      trigger,
      startedAt,
      ...(options.catchupFor ? { catchupFor: options.catchupFor } : {}),
    };
    const status: RunStatusFile = {
      status: options.status ?? "success",
      exitCode: 0,
      startedAt,
      finishedAt: startedAt,
    };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
  }

  const ids = (body: unknown): string[] =>
    (body as ListedRun[]).map((run) => `${run.jobId}/${run.runId}`);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-trigger-"));
    engine = new CronEngine(tmpDir);
    app = createApp(engine, tmpDir, new Date().toISOString());
    // Newest first: a-6 .. a-1 for job "alpha", b-1 for job "beta".
    writeRun("alpha", "a-1", "scheduled", "2026-09-20T09:00:00.000Z");
    writeRun("alpha", "a-2", "catchup", "2026-09-21T08:00:00.000Z", {
      catchupFor: "2026-09-20T09:00:00.000Z",
    });
    writeRun("alpha", "a-3", "manual", "2026-09-22T10:00:00.000Z");
    writeRun("alpha", "a-4", "catchup", "2026-09-23T08:00:00.000Z", {
      catchupFor: "2026-09-22T09:00:00.000Z",
      status: "failed",
    });
    writeRun("alpha", "a-5", "scheduled", "2026-09-24T09:00:00.000Z");
    writeRun("alpha", "a-6", "catchup", "2026-09-25T08:00:00.000Z", {
      catchupFor: "2026-09-24T21:00:00.000Z",
    });
    writeRun("beta", "b-1", "catchup", "2026-09-22T12:00:00.000Z", {
      catchupFor: "2026-09-22T09:00:00.000Z",
    });
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only catch-up runs, newest first, with the slot each one caught up", async () => {
    const res = await request(app, "/api/runs?trigger=catchup");
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([
      "alpha/a-6",
      "alpha/a-4",
      "beta/b-1",
      "alpha/a-2",
    ]);
    expect((res.body as ListedRun[])[0].catchupFor).toBe(
      "2026-09-24T21:00:00.000Z",
    );
  });

  it("filters scheduled and manual runs the same way", async () => {
    expect(
      ids((await request(app, "/api/runs?trigger=scheduled")).body),
    ).toEqual(["alpha/a-5", "alpha/a-1"]);
    expect(ids((await request(app, "/api/runs?trigger=manual")).body)).toEqual([
      "alpha/a-3",
    ]);
  });

  it("applies the limit after filtering, so older catch-ups are not crowded out by other runs", async () => {
    const res = await request(app, "/api/runs?trigger=catchup&limit=3");
    expect(ids(res.body)).toEqual(["alpha/a-6", "alpha/a-4", "beta/b-1"]);
  });

  it("combines with the job and status filters", async () => {
    expect(
      ids((await request(app, "/api/runs?trigger=catchup&job=beta")).body),
    ).toEqual(["beta/b-1"]);
    expect(
      ids((await request(app, "/api/runs?trigger=catchup&status=failed")).body),
    ).toEqual(["alpha/a-4"]);
    expect(
      ids((await request(app, "/api/runs?trigger=scheduled&job=beta")).body),
    ).toEqual([]);
  });

  it("returns every run when no trigger is given", async () => {
    expect(ids((await request(app, "/api/runs")).body)).toHaveLength(7);
  });

  it("rejects an unknown, empty or repeated trigger with 400 and an error message", async () => {
    for (const url of [
      "/api/runs?trigger=retro",
      "/api/runs?trigger=CATCHUP",
      "/api/runs?trigger=",
      "/api/runs?trigger=catchup&trigger=manual",
    ]) {
      const res = await request(app, url);
      expect(res.status, url).toBe(400);
      expect(res.body, url).toEqual({
        error: expect.stringContaining("trigger"),
      });
    }
  });
});
