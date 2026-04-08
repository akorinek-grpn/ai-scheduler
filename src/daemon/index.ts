import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { CronEngine } from "./cron-engine";
import { createApp } from "./api";
import { getDaemonJsonPath } from "@shared/paths";
import type { DaemonHealth } from "@shared/types";

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

  fs.watch(CONFIG_PATH, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
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

async function main(): Promise<void> {
  console.log(`[daemon] Starting AI Scheduler daemon (pid: ${process.pid})`);

  const configResult = loadConfig(CONFIG_PATH);
  if (!configResult.success) {
    console.error(`[daemon] Failed to load config: ${configResult.error}`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const engine = new CronEngine(PROJECT_ROOT);
  engine.loadJobs(configResult.data);

  console.log(`[daemon] Loaded ${Object.keys(configResult.data.jobs).length} jobs`);
  console.log(`[daemon] Scheduled: ${engine.getRegisteredJobIds().join(", ") || "(none)"}`);

  const app = createApp(engine, PROJECT_ROOT, startedAt);
  const server = app.listen(DAEMON_PORT, "127.0.0.1", () => {
    console.log(`[daemon] API listening on http://127.0.0.1:${DAEMON_PORT}`);
  });

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
