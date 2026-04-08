import cron, { type ScheduledTask } from "node-cron";
import type { SchedulerConfig } from "@shared/config-schema";
import type { JobConfig } from "@shared/types";
import { runJob } from "./job-runner";

export class CronEngine {
  private projectRoot: string;
  private tasks: Map<string, ScheduledTask> = new Map();
  private activeJobs: Set<string> = new Set();
  private currentConfig: SchedulerConfig | null = null;

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
    } catch (err) {
      console.error(`[cron] Error running ${jobId}:`, err);
    } finally {
      this.activeJobs.delete(jobId);
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
      return { runId: result.runId };
    } finally {
      this.activeJobs.delete(jobId);
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
