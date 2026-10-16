import express from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { CronEngine } from "./cron-engine";
import { loadConfig } from "./config";
import { getLogPath, getSessionLogPath, getStatusPath } from "@shared/paths";
import { getActivityStats } from "./stats";
import {
  emptyCostTotals,
  getCostStats,
  getRetainedJobCosts,
} from "./cost-stats";
import { listRunSummaries, readRunSummary, safeSegment } from "./run-history";
import { readRunGraph } from "./run-graph-reader";
import { describeHosts, type HostProbe } from "./hosts";
import {
  hostDataRoots,
  producedBy,
  selectHostRoots,
  type HostDataRoot,
} from "./host-data";
import { jobRunsOnRole, type SchedulerConfig } from "@shared/config-schema";
import type { RunStatusFile, TriggerType } from "@shared/types";
import type { CostTotals } from "@shared/cost-types";

const RUN_TRIGGERS: readonly TriggerType[] = ["scheduled", "manual", "catchup"];

export interface CreateAppOptions {
  /** How /api/hosts reaches another host's daemon; tests inject a fake. */
  probeHost?: HostProbe;
}

export function createApp(
  engine: CronEngine,
  projectRoot: string,
  startedAt: string,
  options: CreateAppOptions = {},
): express.Express {
  const configPath = path.join(projectRoot, "scheduler.yaml");
  const app = express();
  app.use(express.json());

  const selfHealth = () => ({
    status: "running",
    pid: process.pid,
    startedAt,
    activeJobs: engine.getActiveJobIds(),
    host: engine.getCurrentConfig()?.host ?? null,
    draining: engine.isDraining(),
    // The account's usage window is exhausted: Claude jobs held until `until` (2026-10-16).
    usageHold: engine.getUsageHold(),
  });

  app.get("/api/health", (_req, res) => {
    res.json(selfHealth());
  });

  // Lift the usage hold before its reset (more usage bought, or the limit text misread).
  app.post("/api/usage-hold/clear", (_req, res) => {
    const cleared = engine.clearUsageHold();
    res.json({ ok: true, cleared });
  });

  // The headroom gauge's samples (scripts/usage-headroom.py, the usage-headroom job): the newest
  // one in full and the last 48 lines of the ledger, plus the hold, for the dashboard card.
  app.get("/api/usage", (_req, res) => {
    const usageDir = path.join(projectRoot, "data", "usage");
    let latest: unknown = null;
    try {
      latest = JSON.parse(fs.readFileSync(path.join(usageDir, "latest.json"), "utf8"));
    } catch {
      latest = null;
    }
    let samples: unknown[] = [];
    try {
      const lines = fs.readFileSync(path.join(usageDir, "headroom.jsonl"), "utf8").trim().split("\n");
      samples = lines
        .slice(-48)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return null;
          }
        })
        .filter((s) => s !== null);
    } catch {
      samples = [];
    }
    res.json({ latest, samples, hold: engine.getUsageHold() });
  });

  // Stop starting runs and exit once the running ones finish (launchd restarts the daemon:
  // see index.ts). deploy-air.sh calls this instead of waiting for an idle moment.
  app.post("/api/drain", (_req, res) => {
    const running = engine.drain();
    console.log(`[daemon] Drain requested via API; running: ${running.join(", ") || "(none)"}`);
    res.json({ ok: true, draining: true, running, pid: process.pid });
  });

  // The whole scheduler.yaml, every host's jobs, cached by mtime: the engine's config holds only
  // this host's jobs, and the dashboard polls every 5 s.
  let full: { mtimeMs: number; config: SchedulerConfig | null; error: string | null } | null = null;
  const fullConfig = (): { config: SchedulerConfig | null; error: string | null } => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(configPath).mtimeMs;
    } catch {
      return { config: null, error: "scheduler.yaml is not readable" };
    }
    if (full && full.mtimeMs === mtimeMs) return full;
    const loaded = loadConfig(configPath, { keepAllJobs: true });
    full = loaded.success
      ? { mtimeMs, config: loaded.data, error: null }
      : { mtimeMs, config: null, error: loaded.error };
    return full;
  };
  // Several hosts share scheduler.yaml: every run carries the host that produced it.
  const multiHost = (): boolean => {
    const config = fullConfig().config;
    return Boolean(config?.hosts && config.host);
  };
  const dataRoots = (): HostDataRoot[] => hostDataRoots(projectRoot, fullConfig().config);
  const HOST_ERROR = { error: "host must be self, all, or a host named in scheduler.yaml" };
  // One host's data for the run endpoints, ?host= (default: this host). Other hosts are mirrors.
  const oneRoot = (selection: unknown): HostDataRoot | null => {
    const roots = selectHostRoots(dataRoots(), selection);
    return roots && roots.length === 1 ? roots[0] : null;
  };
  const tagged = <T extends { host?: string }>(run: T, root: HostDataRoot): T =>
    multiHost() ? { ...run, host: root.name } : run;

  // Every declared host with its placed jobs and its daemon's health.
  app.get("/api/hosts", async (_req, res) => {
    const { config, error } = fullConfig();
    if (!config) {
      res.status(500).json({ error });
      return;
    }
    if (!config.hosts || !config.host) {
      res.json({ self: null, hosts: [] });
      return;
    }
    const hosts = await describeHosts(
      config,
      { ...selfHealth(), host: config.host },
      options.probeHost,
    );
    res.json({ self: config.host, hosts });
  });

  // ?host= (default this host): another host's jobs come from scheduler.yaml and its mirrored
  // runs, read-only. Damaged preserved history must not hide the job list; costs show as
  // unavailable instead.
  app.get("/api/jobs", (req, res) => {
    const selected = selectHostRoots(dataRoots(), req.query.host);
    if (!selected) {
      res.status(400).json(HOST_ERROR);
      return;
    }
    const multi = multiHost();
    const jobs: Record<string, unknown>[] = [];
    for (const root of selected) {
      let costs = new Map<string, CostTotals>();
      try {
        costs = getRetainedJobCosts(root.root, new Date(), multi ? root : undefined);
      } catch (error) {
        console.error(`[costs] Could not load job cost history for ${root.name}:`, error);
      }
      if (root.isSelf) {
        const config = engine.getCurrentConfig();
        for (const [id, job] of Object.entries(config?.jobs ?? {})) {
          jobs.push({
            id,
            ...job,
            isActive: engine.getActiveJobIds().includes(id),
            cost: costs.get(id) ?? emptyCostTotals(),
            ...(multi ? { host: root.name, readOnly: false } : {}),
          });
        }
        continue;
      }
      const running = new Set(
        listRunSummaries(root.root)
          .filter((run) => run.status === "running" && producedBy(root, run.host))
          .map((run) => run.jobId),
      );
      for (const [id, job] of Object.entries(fullConfig().config?.jobs ?? {})) {
        if (!jobRunsOnRole(job, root.role)) continue;
        jobs.push({
          id,
          ...job,
          isActive: running.has(id),
          cost: costs.get(id) ?? emptyCostTotals(),
          host: root.name,
          readOnly: true,
        });
      }
    }
    res.json(jobs);
  });

  // Jobs scheduler.yaml places on hosts other than `role`. Their history can still sit in that
  // host's data (from before the split), and would otherwise fill its dashboard, timeline and
  // runs list. Cached with the config.
  const placedElsewhere = new Map<string, { config: SchedulerConfig; jobs: Set<string> }>();
  const jobsPlacedElsewhere = (role: string): Set<string> => {
    const config = fullConfig().config;
    if (!config?.host) return new Set();
    const cached = placedElsewhere.get(role);
    if (cached && cached.config === config) return cached.jobs;
    const jobs = new Set<string>();
    for (const [id, job] of Object.entries(config.jobs)) {
      if (!jobRunsOnRole(job, role)) jobs.add(id);
    }
    placedElsewhere.set(role, { config, jobs });
    return jobs;
  };

  app.get("/api/runs", (req, res) => {
    const jobFilter = req.query.job as string | undefined;
    const statusFilter = req.query.status as string | undefined;
    const triggerFilter = req.query.trigger;
    const scope = req.query.scope;
    const limit = parseInt(req.query.limit as string) || 50;
    if (
      triggerFilter !== undefined &&
      !RUN_TRIGGERS.some((trigger) => trigger === triggerFilter)
    ) {
      res
        .status(400)
        .json({ error: `trigger must be one of: ${RUN_TRIGGERS.join(", ")}` });
      return;
    }
    // scope=host (default): for one selected host, runs of jobs placed on it plus jobs the file
    // no longer names. scope=all: every run that host produced.
    if (scope !== undefined && scope !== "host" && scope !== "all") {
      res.status(400).json({ error: "scope must be host or all" });
      return;
    }
    // since/until (ISO times): runs that started in that window, e.g. one timeline week.
    const since = req.query.since === undefined ? -Infinity : Date.parse(String(req.query.since));
    const until = req.query.until === undefined ? Infinity : Date.parse(String(req.query.until));
    if (Number.isNaN(since) || Number.isNaN(until)) {
      res.status(400).json({ error: "since and until must be ISO date-times" });
      return;
    }
    // host (default this host): which host's runs; all = every host, each run once.
    const selected = selectHostRoots(dataRoots(), req.query.host);
    if (!selected) {
      res.status(400).json(HOST_ERROR);
      return;
    }
    const multi = multiHost();
    const hidden =
      scope === "all" || selected.length !== 1 || !multi
        ? new Set<string>()
        : jobsPlacedElsewhere(selected[0].role);

    const seen = new Set<string>();
    const runs = selected
      .flatMap((root) =>
        listRunSummaries(root.root, jobFilter)
          .filter((run) => !multi || producedBy(root, run.host))
          .map((run) => tagged(run, root)),
      )
      .filter((run) => {
        const key = `${run.jobId}/${run.runId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .filter((run) => !hidden.has(run.jobId))
      .filter((run) => {
        const started = Date.parse(run.startedAt);
        return started >= since && started < until;
      })
      .filter((run) => !statusFilter || run.status === statusFilter)
      .filter(
        (run) => triggerFilter === undefined || run.trigger === triggerFilter,
      )
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    res.json(runs.slice(0, limit));
  });

  app.get("/api/runs/:jobId/:runId", (req, res) => {
    const root = oneRoot(req.query.host);
    if (!root) {
      res.status(400).json(HOST_ERROR);
      return;
    }
    const run = readRunSummary(root.root, req.params.jobId, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(tagged(run, root));
  });

  app.get("/api/runs/:jobId/:runId/log", (req, res) => {
    const { jobId, runId } = req.params;
    const offset = parseInt(req.query.offset as string) || 0;
    const root = oneRoot(req.query.host);
    if (!root) {
      res.status(400).json(HOST_ERROR);
      return;
    }
    if (!safeSegment(jobId) || !safeSegment(runId)) {
      res.status(404).json({ error: "Log not found" });
      return;
    }
    // file=session: the text of the inner Claude sessions a script run started.
    const file = req.query.file;
    if (file !== undefined && file !== "output" && file !== "session") {
      res.status(400).json({ error: "file must be output or session" });
      return;
    }
    const logPath =
      file === "session"
        ? getSessionLogPath(root.root, jobId, runId)
        : getLogPath(root.root, jobId, runId);

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
      const statusPath = getStatusPath(root.root, jobId, runId);
      let isDone = false;
      try {
        const status: RunStatusFile = JSON.parse(
          fs.readFileSync(statusPath, "utf-8"),
        );
        isDone = status.status !== "running";
      } catch {
        /* noop */
      }

      res.json({
        content,
        offset: offset + Buffer.byteLength(content),
        done: isDone,
      });
    });
  });

  app.get("/api/runs/:jobId/:runId/graph", (req, res) => {
    const { jobId, runId } = req.params;
    const root = oneRoot(req.query.host);
    if (!root) {
      res.status(400).json(HOST_ERROR);
      return;
    }
    try {
      const graph = readRunGraph(root.root, jobId, runId);
      if (!graph) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(graph);
    } catch (error) {
      console.error(
        `[graph] Could not build the run graph for ${jobId}/${runId}:`,
        error,
      );
      res.status(500).json({ error: "Could not build the run graph" });
    }
  });

  app.patch("/api/jobs/:jobId", (req, res) => {
    const { jobId } = req.params;
    const { enabled } = req.body as { enabled?: boolean };

    if (typeof enabled !== "boolean") {
      res
        .status(400)
        .json({ error: "Request body must include { enabled: boolean }" });
      return;
    }

    // Read raw YAML, update the enabled field, write back
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf-8");
    } catch (err) {
      res
        .status(500)
        .json({ error: `Failed to read config: ${(err as Error).message}` });
      return;
    }

    const parsed = yaml.load(raw) as Record<string, unknown>;
    const jobs = parsed?.jobs as
      Record<string, Record<string, unknown>> | undefined;

    if (!jobs?.[jobId]) {
      res.status(404).json({ error: `Job '${jobId}' not found` });
      return;
    }

    jobs[jobId].enabled = enabled;

    try {
      fs.writeFileSync(
        configPath,
        yaml.dump(parsed, { lineWidth: -1, noRefs: true }),
        "utf-8",
      );
    } catch (err) {
      res
        .status(500)
        .json({ error: `Failed to write config: ${(err as Error).message}` });
      return;
    }

    console.log(
      `[daemon] Job '${jobId}' ${enabled ? "enabled" : "disabled"} via API`,
    );
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
      res.json(getActivityStats(projectRoot, days, multiHost() ? dataRoots() : undefined));
    } catch (error) {
      console.error("[activity] Could not load activity history:", error);
      res.status(503).json({ error: "Activity history is unavailable" });
    }
  });

  app.get("/api/stats/costs", (req, res) => {
    const raw = req.query.days ?? "30";
    const days =
      typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      res.status(400).json({ error: "days must be an integer from 1 to 90" });
      return;
    }
    try {
      res.json(
        getCostStats(projectRoot, days, new Date(), multiHost() ? dataRoots() : undefined),
      );
    } catch (error) {
      console.error("[costs] Could not load cost history:", error);
      res.status(503).json({ error: "Cost history is unavailable" });
    }
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
