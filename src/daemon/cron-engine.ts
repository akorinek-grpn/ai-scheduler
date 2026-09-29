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
  /** When each job's current cron task was created (see getScheduledSince). */
  private scheduledSince: Map<string, Date> = new Map();
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
        this.scheduledSince.delete(jobId);
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

      // The tick resolves the job's config at fire time, not at schedule time
      // (2026-09-28): loadJobs keeps an existing task when only the prompt, model,
      // timeout or directory changed, so a closure over `jobConfig` ran the OLD
      // prompt until the schedule changed or the daemon restarted - while the
      // hot-reload log said "Reloaded config".
      // ctx.date is the slot node-cron matched (to the second).
      const task = cron.schedule(jobConfig.schedule, (ctx) => {
        void this.executeJob(jobId, ctx.date);
      });

      this.tasks.set(jobId, task);
      this.scheduledSince.set(jobId, new Date());
    }

    this.currentConfig = config;
  }

  /** The config a scheduled tick should run with: whatever was loaded most recently. */
  private resolveJob(
    jobId: string,
  ): { jobConfig: JobConfig; config: SchedulerConfig } | null {
    const config = this.currentConfig;
    const jobConfig = config?.jobs[jobId];
    if (!config || !jobConfig || !jobConfig.enabled) return null;
    return { jobConfig, config };
  }

  private async executeJob(
    jobId: string,
    slot: Date = new Date(),
  ): Promise<void> {
    const resolved = this.resolveJob(jobId);
    if (!resolved) {
      console.warn(
        `[cron] Skipping ${jobId} — no longer in the loaded config or disabled`,
      );
      return;
    }
    const { jobConfig, config } = resolved;
    if (this.activeJobs.has(jobId)) {
      console.warn(`[cron] Skipping ${jobId} — previous run still active`);
      // Queued under the tick's own slot: if that run is already a catch-up of this
      // slot (a sweep got there first), the queue refuses it instead of running it twice.
      this.catchupQueue?.enqueue(jobId, slot);
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
        maxRetries: jobConfig.max_retries ?? config.defaults.max_retries,
      });
      if (result.status === "success") {
        console.log(`[cron] Completed ${jobId}: success`);
      } else {
        // stderr so failures stand out in daemon.log and can be grepped/acted on
        console.error(
          `[cron] Completed ${jobId}: ${result.status} (exit code ${result.exitCode}) - see data/runs/${jobId}/${result.runId}/output.log`,
        );
      }
      evaluateRun(
        this.projectRoot,
        jobId,
        result.runId,
        jobConfig.name,
        result.status,
        result.exitCode,
      ).catch((err) =>
        console.error(`[eval] ${jobId}: evaluation failed:`, err),
      );
      pruneOldRuns(this.projectRoot, jobId, config.defaults.retain_runs);
    } catch (err) {
      console.error(`[cron] Error running ${jobId}:`, err);
    } finally {
      this.activeJobs.delete(jobId);
      this.catchupQueue?.process();
    }
  }

  async triggerJob(
    jobId: string,
  ): Promise<{ runId: string } | { error: string }> {
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
        maxRetries:
          jobConfig.max_retries ?? this.currentConfig.defaults.max_retries,
      });
      evaluateRun(
        this.projectRoot,
        jobId,
        result.runId,
        jobConfig.name,
        result.status,
        result.exitCode,
      ).catch((err) =>
        console.error(`[eval] ${jobId}: evaluation failed:`, err),
      );
      if (this.currentConfig) {
        pruneOldRuns(
          this.projectRoot,
          jobId,
          this.currentConfig.defaults.retain_runs,
        );
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
    if (this.activeJobs.has(jobId))
      return { error: `Job already running: ${jobId}` };

    this.activeJobs.add(jobId);
    try {
      const result = await runJob({
        jobId,
        jobConfig,
        projectRoot: this.projectRoot,
        trigger: "catchup",
        catchupFor: missedSlot.toISOString(),
        defaultTimeout: this.currentConfig.defaults.timeout,
        maxRetries:
          jobConfig.max_retries ?? this.currentConfig.defaults.max_retries,
      });
      evaluateRun(
        this.projectRoot,
        jobId,
        result.runId,
        jobConfig.name,
        result.status,
        result.exitCode,
      ).catch((err) =>
        console.error(`[eval] ${jobId}: evaluation failed:`, err),
      );
      pruneOldRuns(
        this.projectRoot,
        jobId,
        this.currentConfig.defaults.retain_runs,
      );
      return { runId: result.runId };
    } finally {
      this.activeJobs.delete(jobId);
      this.catchupQueue?.process();
    }
  }

  /**
   * When the job's current cron task was scheduled, or null if it has none. node-cron can
   * only have fired (or dropped) the job's slots from then on, so the missed-tick check
   * ignores earlier ones: a job added or re-enabled at 14:05 does not catch up 14:00.
   */
  getScheduledSince(jobId: string): Date | null {
    return this.scheduledSince.get(jobId) ?? null;
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
    this.scheduledSince.clear();
  }
}
