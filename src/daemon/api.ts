import express from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { CronEngine } from "./cron-engine";
import { loadConfig } from "./config";
import { getLogPath, getStatusPath } from "@shared/paths";
import { getActivityStats } from "./stats";
import { emptyCostTotals, getCostStats, getRetainedJobCosts } from "./cost-stats";
import { listRunSummaries, readRunSummary } from "./run-history";
import { readRunGraph } from "./run-graph-reader";
import type { RunStatusFile, TriggerType } from "@shared/types";

const RUN_TRIGGERS: readonly TriggerType[] = ["scheduled", "manual", "catchup"];

export function createApp(engine: CronEngine, projectRoot: string, startedAt: string): express.Express {
  const configPath = path.join(projectRoot, "scheduler.yaml");
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "running",
      pid: process.pid,
      startedAt,
      activeJobs: engine.getActiveJobIds(),
    });
  });

  app.get("/api/jobs", (_req, res) => {
    const config = engine.getCurrentConfig();
    if (!config) {
      res.json([]);
      return;
    }

    const costs = getRetainedJobCosts(projectRoot);
    const jobs = Object.entries(config.jobs).map(([id, job]) => ({
      id,
      ...job,
      isActive: engine.getActiveJobIds().includes(id),
      cost: costs.get(id) ?? emptyCostTotals(),
    }));

    res.json(jobs);
  });

  app.get("/api/runs", (req, res) => {
    const jobFilter = req.query.job as string | undefined;
    const statusFilter = req.query.status as string | undefined;
    const triggerFilter = req.query.trigger;
    const limit = parseInt(req.query.limit as string) || 50;
    if (triggerFilter !== undefined && !RUN_TRIGGERS.some((trigger) => trigger === triggerFilter)) {
      res.status(400).json({ error: `trigger must be one of: ${RUN_TRIGGERS.join(", ")}` });
      return;
    }

    const runs = listRunSummaries(projectRoot, jobFilter)
      .filter((run) => !statusFilter || run.status === statusFilter)
      .filter((run) => triggerFilter === undefined || run.trigger === triggerFilter);
    res.json(runs.slice(0, limit));
  });

  app.get("/api/runs/:jobId/:runId", (req, res) => {
    const run = readRunSummary(projectRoot, req.params.jobId, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  });

  app.get("/api/runs/:jobId/:runId/log", (req, res) => {
    const { jobId, runId } = req.params;
    const offset = parseInt(req.query.offset as string) || 0;
    const logPath = getLogPath(projectRoot, jobId, runId);

    if (!fs.existsSync(logPath)) {
      res.status(404).json({ error: "Log not found" });
      return;
    }

    const stat = fs.statSync(logPath);
    if (offset >= stat.size) {
      res.json({ content: "", offset: stat.size, done: false });
      return;
    }

    const stream = fs.createReadStream(logPath, { start: offset });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", () => {
      const content = Buffer.concat(chunks).toString("utf-8");
      const statusPath = getStatusPath(projectRoot, jobId, runId);
      let isDone = false;
      try {
        const status: RunStatusFile = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        isDone = status.status !== "running";
      } catch { /* noop */ }

      res.json({
        content,
        offset: offset + Buffer.byteLength(content),
        done: isDone,
      });
    });
  });

  app.get("/api/runs/:jobId/:runId/graph", (req, res) => {
    const { jobId, runId } = req.params;
    try {
      const graph = readRunGraph(projectRoot, jobId, runId);
      if (!graph) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(graph);
    } catch (error) {
      console.error(`[graph] Could not build the run graph for ${jobId}/${runId}:`, error);
      res.status(500).json({ error: "Could not build the run graph" });
    }
  });

  app.patch("/api/jobs/:jobId", (req, res) => {
    const { jobId } = req.params;
    const { enabled } = req.body as { enabled?: boolean };

    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "Request body must include { enabled: boolean }" });
      return;
    }

    // Read raw YAML, update the enabled field, write back
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch (err) {
      res.status(500).json({ error: `Failed to read config: ${(err as Error).message}` });
      return;
    }

    const parsed = yaml.load(raw) as Record<string, unknown>;
    const jobs = parsed?.jobs as Record<string, Record<string, unknown>> | undefined;

    if (!jobs?.[jobId]) {
      res.status(404).json({ error: `Job '${jobId}' not found` });
      return;
    }

    jobs[jobId].enabled = enabled;

    try {
      fs.writeFileSync(configPath, yaml.dump(parsed, { lineWidth: -1, noRefs: true }), "utf-8");
    } catch (err) {
      res.status(500).json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    console.log(`[daemon] Job '${jobId}' ${enabled ? "enabled" : "disabled"} via API`);
    res.json({ ok: true, jobId, enabled });
  });

  app.post("/api/reload", (_req, res) => {
    const result = loadConfig(configPath);
    if (result.success) {
      engine.loadJobs(result.data);
      const jobCount = Object.keys(result.data.jobs).length;
      console.log(`[daemon] Config reloaded via API: ${jobCount} jobs`);
      res.json({ ok: true, jobs: jobCount });
    } else {
      console.error(`[daemon] Config reload failed: ${result.error}`);
      res.status(400).json({ ok: false, error: result.error });
    }
  });

  app.post("/api/runs/:jobId/trigger", async (req, res) => {
    const { jobId } = req.params;
    const result = await engine.triggerJob(jobId);

    if ("error" in result) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  app.get("/api/stats/activity", (req, res) => {
    const raw = parseInt(req.query.days as string, 10);
    const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, raw)) : 30;
    try {
      res.json(getActivityStats(projectRoot, days));
    } catch (error) {
      console.error("[activity] Could not load activity history:", error);
      res.status(503).json({ error: "Activity history is unavailable" });
    }
  });

  app.get("/api/stats/costs", (req, res) => {
    const raw = req.query.days ?? "30";
    const days = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      res.status(400).json({ error: "days must be an integer from 1 to 90" });
      return;
    }
    res.json(getCostStats(projectRoot, days));
  });

  app.get("/api/queue/catchups", (_req, res) => {
    const queue = engine.getCatchupQueue();
    if (!queue) {
      res.json({ queued: [], inFlight: null });
      return;
    }
    res.json(queue.snapshot());
  });

  return app;
}
