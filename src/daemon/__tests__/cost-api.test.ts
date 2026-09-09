import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import { getRunDir } from "@shared/paths";
import { CostTracker, writeRunCost } from "../costs";

let root: string;
let server: Server;
let baseUrl: string;
let engine: CronEngine;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-cost-api-"));
  engine = new CronEngine(root);
  engine.loadJobs({ version: 1, defaults: { timeout: 300, max_retries: 0, retain_runs: 50 }, jobs: {
    job: { name: "Cost test", type: "claude", schedule: "0 0 * * *", directory: root, prompt: "test", enabled: false, skip_permissions: false, tags: [] },
  } });
  await new Promise<void>((resolve) => {
    server = createApp(engine, root, new Date().toISOString()).listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  engine.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
});

function seed(runId: string, startedAt: string, amount = 0.1): void {
  const directory = getRunDir(root, "job", runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId: "job", runId, jobConfig: { name: "Cost test", directory: root }, trigger: "catchup", startedAt, catchupFor: startedAt }));
  fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ status: "success", startedAt, finishedAt: startedAt, exitCode: 0 }));
  const tracker = new CostTracker("claude", 1);
  tracker.consume(JSON.stringify({ type: "result", total_cost_usd: amount }));
  writeRunCost(root, "job", runId, [tracker.snapshot()]);
}

describe("cost API", () => {
  it("exposes costs on runs, jobs, and range stats without the run-list limit affecting totals", async () => {
    for (let index = 0; index < 55; index++) seed(`run-${index}`, new Date().toISOString());
    const runs = await (await fetch(`${baseUrl}/api/runs?limit=1`)).json();
    expect(runs).toHaveLength(1);
    expect(runs[0].cost.executionCostUsd).toBe(0.1);
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    expect(jobs[0].cost).toMatchObject({ totalCostUsd: 5.5, runs: 55, trackedRuns: 55 });
    const stats = await (await fetch(`${baseUrl}/api/stats/costs?days=7`)).json();
    expect(stats.daily).toHaveLength(7);
    expect(stats.period.totalCostUsd).toBe(5.5);
  });

  it("can retrieve an exact older run even when it is not in the latest 50", async () => {
    seed("old", "2026-01-01T00:00:00Z", 2);
    for (let index = 0; index < 51; index++) seed(`run-${index}`, new Date().toISOString());
    const response = await fetch(`${baseUrl}/api/runs/job/old`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: "old", cost: { totalCostUsd: 2 }, catchupFor: "2026-01-01T00:00:00Z" });
  });

  it.each(["0", "91", "NaN", "7foo", "7.5", "7&days=30"])("rejects an invalid cost window: %s", async (days) => {
    expect((await fetch(`${baseUrl}/api/stats/costs?days=${days}`)).status).toBe(400);
  });

  it("returns JSON errors for missing runs and blocks path traversal or symlink aliases", async () => {
    for (const target of ["job/missing", "job/latest", "job/..%2Foutside"]) {
      const response = await fetch(`${baseUrl}/api/runs/${target}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toHaveProperty("error");
    }
  });
});
