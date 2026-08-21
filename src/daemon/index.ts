import fs from "fs";
import path from "path";
import http0 from "http";
import express0 from "express";
import { loadConfig } from "./config";
import { CronEngine } from "./cron-engine";
import { createApp } from "./api";
import { getDaemonJsonPath, getRunsDir, getStatusPath, getLatestRunStartedAt } from "@shared/paths";
import { CatchupQueue, detectMissedRun } from "./catchup";
import { listenExclusive, PortInUseError } from "./single-instance";
import type { DaemonHealth, RunStatusFile } from "@shared/types";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "scheduler.yaml");
const DAEMON_PORT = 3501;

function writeDaemonJson(startedAt: string, port: number): void {
  const daemonJsonPath = getDaemonJsonPath(PROJECT_ROOT);
  fs.mkdirSync(path.dirname(daemonJsonPath), { recursive: true });

  const health: DaemonHealth = {
    status: "running",
    pid: process.pid,
    port,
    startedAt,
    lastHeartbeat: new Date().toISOString(),
    activeJobs: [],
  };
  fs.writeFileSync(daemonJsonPath, JSON.stringify(health, null, 2));
}

function startHeartbeat(engine: CronEngine, startedAt: string, port: number): NodeJS.Timeout {
  return setInterval(() => {
    const daemonJsonPath = getDaemonJsonPath(PROJECT_ROOT);
    const health: DaemonHealth = {
      status: "running",
      pid: process.pid,
      port,
      startedAt,
      lastHeartbeat: new Date().toISOString(),
      activeJobs: engine.getActiveJobIds(),
    };
    fs.writeFileSync(daemonJsonPath, JSON.stringify(health, null, 2));
  }, 30_000);
}

function watchConfig(engine: CronEngine): void {
  let debounceTimer: NodeJS.Timeout | null = null;
  // macOS fs.watch can fire spurious events even when the file hasn't changed.
  // Compare raw content against the last-seen version to avoid reload storms.
  let lastContent: string | null = null;
  try {
    lastContent = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    // Will be picked up on the first real event.
  }

  fs.watch(CONFIG_PATH, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      let raw: string;
      try {
        raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      } catch (err) {
        console.error(`[daemon] Config read failed: ${(err as Error).message}`);
        return;
      }
      if (raw === lastContent) return;
      lastContent = raw;

      console.log("[daemon] Config change detected, reloading...");
      const result = loadConfig(CONFIG_PATH);
      if (result.success) {
        engine.loadJobs(result.data);
        console.log(`[daemon] Reloaded config: ${Object.keys(result.data.jobs).length} jobs`);
      } else {
        console.error(`[daemon] Config reload failed: ${result.error}`);
      }
    }, 500);
  });
}

function cleanupOrphanedRuns(projectRoot: string): void {
  const runsDir = getRunsDir(projectRoot);
  if (!fs.existsSync(runsDir)) return;

  let cleaned = 0;
  for (const jobId of fs.readdirSync(runsDir)) {
    const jobDir = path.join(runsDir, jobId);
    if (!fs.statSync(jobDir).isDirectory()) continue;

    for (const runId of fs.readdirSync(jobDir)) {
      if (runId === "latest") continue;
      const statusPath = getStatusPath(projectRoot, jobId, runId);
      if (!fs.existsSync(statusPath)) continue;

      try {
        const status: RunStatusFile = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        if (status.status === "running") {
          const updated: RunStatusFile = {
            ...status,
            status: "failed",
            finishedAt: new Date().toISOString(),
          };
          fs.writeFileSync(statusPath, JSON.stringify(updated, null, 2));
          cleaned++;
        }
      } catch {
        // skip corrupt status files
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[daemon] Cleaned up ${cleaned} orphaned run(s) from previous session`);
  }
}

async function main(): Promise<void> {
  console.log(`[daemon] Starting AI Scheduler daemon (pid: ${process.pid})`);

  // Claim the port first. It is the only reliable single-instance lock, and it
  // has to happen before any job is scheduled: a second daemon that loses the
  // bind but keeps going still registers every cron task, and each process has
  // its own in-memory active-job guard, so every job runs twice.
  const app0 = express0();
  const server = http0.createServer(app0);
  try {
    await listenExclusive(server, DAEMON_PORT, "127.0.0.1");
  } catch (err) {
    if (err instanceof PortInUseError) {
      console.error(
        `[daemon] Another daemon is already listening on port ${DAEMON_PORT}. ` +
          `Refusing to start a second instance - it would schedule every job a ` +
          `second time. Stop the running one first (./scripts/stop-daemon.sh).`,
      );
      process.exit(1);
    }
    console.error(`[daemon] Failed to bind port ${DAEMON_PORT}:`, err);
    process.exit(1);
  }

  cleanupOrphanedRuns(PROJECT_ROOT);

  const configResult = loadConfig(CONFIG_PATH);
  if (!configResult.success) {
    console.error(`[daemon] Failed to load config: ${configResult.error}`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const engine = new CronEngine(PROJECT_ROOT);
  engine.loadJobs(configResult.data);

  const catchupQueue = new CatchupQueue({
    runCatchup: async (jobId, slot) => {
      await engine.runCatchup(jobId, slot);
    },
    isJobActive: (jobId) => engine.getActiveJobIds().includes(jobId),
    jobName: (jobId) => engine.getCurrentConfig()?.jobs[jobId]?.name ?? jobId,
  });
  engine.setCatchupQueue(catchupQueue);

  const now = new Date();
  let enqueuedCount = 0;
  for (const [jobId, jobConfig] of Object.entries(configResult.data.jobs)) {
    if (!jobConfig.enabled) continue;
    const lastStartedAt = getLatestRunStartedAt(PROJECT_ROOT, jobId);
    const missed = detectMissedRun({
      schedule: jobConfig.schedule,
      lastStartedAt,
      now,
      isActive: engine.getActiveJobIds().includes(jobId),
    });
    if (missed) {
      catchupQueue.enqueue(jobId, missed);
      enqueuedCount += 1;
      console.log(`[catchup] Enqueued ${jobId} for missed slot ${missed.toISOString()}`);
    }
  }
  if (enqueuedCount > 0) {
    console.log(`[catchup] ${enqueuedCount} catch-up(s) queued from startup detection`);
    catchupQueue.process();
  }

  console.log(`[daemon] Loaded ${Object.keys(configResult.data.jobs).length} jobs`);
  console.log(`[daemon] Scheduled: ${engine.getRegisteredJobIds().join(", ") || "(none)"}`);

  // The port was already claimed above; attach the real routes to it now.
  const app = createApp(engine, PROJECT_ROOT, startedAt);
  app0.use(app);
  console.log(`[daemon] API listening on http://127.0.0.1:${DAEMON_PORT}`);

  writeDaemonJson(startedAt, DAEMON_PORT);
  const heartbeatInterval = startHeartbeat(engine, startedAt, DAEMON_PORT);
  watchConfig(engine);

  const shutdown = () => {
    console.log("\n[daemon] Shutting down...");
    engine.stopAll();
    clearInterval(heartbeatInterval);
    server.close();

    const daemonJsonPath = getDaemonJsonPath(PROJECT_ROOT);
    try {
      fs.unlinkSync(daemonJsonPath);
    } catch { /* noop */ }

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
