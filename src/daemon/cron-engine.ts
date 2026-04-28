import cron, { type ScheduledTask } from "node-cron";
import type { SchedulerConfig } from "@shared/config-schema";
import type { JobConfig } from "@shared/types";
import { runJob } from "./job-runner";
import { pruneOldRuns } from "./pruner";
import { evaluateRun } from "./evaluator";
import type { CatchupQueue } from "./catchup";

export class CronEngine {
  private projectRoot: string;
  private tasks: Map<string, ScheduledTask> = new Map();
  private activeJobs: Set<string> = new Set();
  private currentConfig: SchedulerConfig | null = null;
  private catchupQueue: CatchupQueue | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  loadJobs(config: SchedulerConfig): void {
    // Remove jobs no longer in config or changed
    for (const [jobId, task] of this.tasks) {
      if (!config.jobs[jobId] || !config.jobs[jobId].enabled) {
        task.stop();
        this.tasks.delete(jobId);
      }
    }

    // Add or update jobs
    for (const [jobId, jobConfig] of Object.entries(config.jobs)) {
      if (!jobConfig.enabled) continue;

      const existingSchedule = this.currentConfig?.jobs[jobId]?.schedule;
      const isScheduleChanged = existingSchedule !== jobConfig.schedule;

      if (this.tasks.has(jobId) && !isScheduleChanged) continue;

      // Remove old task if schedule changed
      if (this.tasks.has(jobId)) {
        this.tasks.get(jobId)!.stop();
        this.tasks.delete(jobId);
      }

      const task = cron.schedule(jobConfig.schedule, () => {
        void this.executeJob(jobId, jobConfig, config);
      });

      this.tasks.set(jobId, task);
    }

    this.currentConfig = config;
  }

  private async executeJob(
    jobId: string,
    jobConfig: JobConfig,
    config: SchedulerConfig,
  ): Promise<void> {
    if (this.activeJobs.has(jobId)) {
      console.warn(`[cron] Skipping ${jobId} — previous run still active`);
      this.catchupQueue?.enqueue(jobId, new Date());
      return;
    }

    this.activeJobs.add(jobId);
    console.log(`[cron] Starting scheduled run: ${jobId}`);

    try {
      const result = await runJob({
        jobId,
        jobConfig,
        projectRoot: this.projectRoot,
        trigger: "scheduled",
        defaultTimeout: config.defaults.timeout,
      });
      console.log(`[cron] Completed ${jobId}: ${result.status}`);
      evaluateRun(this.projectRoot, jobId, result.runId, jobConfig.name, result.status, result.exitCode)
        .catch((err) => console.error(`[eval] ${jobId}: evaluation failed:`, err));
      pruneOldRuns(this.projectRoot, jobId, config.defaults.retain_runs);
    } catch (err) {
      console.error(`[cron] Error running ${jobId}:`, err);
    } finally {
      this.activeJobs.delete(jobId);
      this.catchupQueue?.process();
    }
  }

  async triggerJob(jobId: string): Promise<{ runId: string } | { error: string }> {
    if (!this.currentConfig) {
      return { error: "No config loaded" };
    }

    const jobConfig = this.currentConfig.jobs[jobId];
    if (!jobConfig) {
      return { error: `Job not found: ${jobId}` };
    }

    if (this.activeJobs.has(jobId)) {
      return { error: `Job already running: ${jobId}` };
    }

    this.activeJobs.add(jobId);

    try {
      const result = await runJob({
        jobId,
        jobConfig,
        projectRoot: this.projectRoot,
        trigger: "manual",
        defaultTimeout: this.currentConfig.defaults.timeout,
      });
      evaluateRun(this.projectRoot, jobId, result.runId, jobConfig.name, result.status, result.exitCode)
        .catch((err) => console.error(`[eval] ${jobId}: evaluation failed:`, err));
      if (this.currentConfig) {
        pruneOldRuns(this.projectRoot, jobId, this.currentConfig.defaults.retain_runs);
      }
      return { runId: result.runId };
    } finally {
      this.activeJobs.delete(jobId);
      this.catchupQueue?.process();
    }
  }

  setCatchupQueue(queue: CatchupQueue): void {
    this.catchupQueue = queue;
  }

  getCatchupQueue(): CatchupQueue | null {
    return this.catchupQueue;
  }

  async runCatchup(
    jobId: string,
    missedSlot: Date,
  ): Promise<{ runId: string } | { error: string }> {
    if (!this.currentConfig) return { error: "No config loaded" };
    const jobConfig = this.currentConfig.jobs[jobId];
    if (!jobConfig) return { error: `Job not found: ${jobId}` };
    if (this.activeJobs.has(jobId)) return { error: `Job already running: ${jobId}` };

    this.activeJobs.add(jobId);
    try {
      const result = await runJob({
        jobId,
        jobConfig,
        projectRoot: this.projectRoot,
        trigger: "catchup",
        catchupFor: missedSlot.toISOString(),
        defaultTimeout: this.currentConfig.defaults.timeout,
      });
      evaluateRun(this.projectRoot, jobId, result.runId, jobConfig.name, result.status, result.exitCode)
        .catch((err) => console.error(`[eval] ${jobId}: evaluation failed:`, err));
      pruneOldRuns(this.projectRoot, jobId, this.currentConfig.defaults.retain_runs);
      return { runId: result.runId };
    } finally {
      this.activeJobs.delete(jobId);
      this.catchupQueue?.process();
    }
  }

  getRegisteredJobIds(): string[] {
    return Array.from(this.tasks.keys());
  }

  getActiveJobIds(): string[] {
    return Array.from(this.activeJobs);
  }

  getCurrentConfig(): SchedulerConfig | null {
    return this.currentConfig;
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }
}
