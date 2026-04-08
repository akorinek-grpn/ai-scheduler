import express from "express";
import fs from "fs";
import path from "path";
import { CronEngine } from "./cron-engine";
import { getRunsDir, getLogPath, getStatusPath, getMetaPath } from "@shared/paths";
import type { RunSummary, RunMeta, RunStatusFile } from "@shared/types";

export function createApp(engine: CronEngine, projectRoot: string, startedAt: string): express.Express {
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

    const jobs = Object.entries(config.jobs).map(([id, job]) => ({
      id,
      ...job,
      isActive: engine.getActiveJobIds().includes(id),
    }));

    res.json(jobs);
  });

  app.get("/api/runs", (req, res) => {
    const jobFilter = req.query.job as string | undefined;
    const statusFilter = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    const runsDir = getRunsDir(projectRoot);
    const runs: RunSummary[] = [];

    if (!fs.existsSync(runsDir)) {
      res.json([]);
      return;
    }

    const jobDirs = fs.readdirSync(runsDir).filter((d) => {
      if (jobFilter && d !== jobFilter) return false;
      const fullPath = path.join(runsDir, d);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const jobId of jobDirs) {
      const jobDir = path.join(runsDir, jobId);
      const runDirs = fs.readdirSync(jobDir).filter((d) => {
        if (d === "latest") return false;
        return fs.statSync(path.join(jobDir, d)).isDirectory();
      });

      for (const runId of runDirs) {
        try {
          const metaPath = getMetaPath(projectRoot, jobId, runId);
          const statusPath = getStatusPath(projectRoot, jobId, runId);

          if (!fs.existsSync(metaPath) || !fs.existsSync(statusPath)) continue;

          const meta: RunMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const status: RunStatusFile = JSON.parse(fs.readFileSync(statusPath, "utf-8"));

          if (statusFilter && status.status !== statusFilter) continue;

          runs.push({
            jobId,
            runId,
            jobName: meta.jobConfig.name,
            directory: meta.jobConfig.directory,
            status: status.status,
            trigger: meta.trigger,
            startedAt: status.startedAt,
            finishedAt: status.finishedAt,
            exitCode: status.exitCode,
          });
        } catch {
          // skip corrupt run data
        }
      }
    }

    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    res.json(runs.slice(0, limit));
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

  app.post("/api/runs/:jobId/trigger", async (req, res) => {
    const { jobId } = req.params;
    const result = await engine.triggerJob(jobId);

    if ("error" in result) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  });

  return app;
}
