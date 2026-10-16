import cron, { type ScheduledTask } from "node-cron";
import type { SchedulerConfig } from "@shared/config-schema";
import {
  DEFERRED_RETRY,
  type JobConfig,
  type TriggerType,
  type UsageHold,
  type UsageLimitHit,
} from "@shared/types";
import { runJob } from "./job-runner";
import { pruneOldRuns } from "./pruner";
import { evaluateDeferredRun, evaluateRun, evaluateUsageLimitedRun } from "./evaluator";
import { holdUntil } from "./usage-limit";
import { readUsageHold, removeUsageHold, writeUsageHold } from "./usage-hold";
import type { CatchupQueue, QueueRunOptions } from "./catchup";

/** How long a slot's deferred-retry count is remembered (slots older than this never retry). */
const RETRY_MEMORY_MS = 24 * 60 * 60 * 1000;

export class CronEngine {
  private projectRoot: string;
  private tasks: Map<string, ScheduledTask> = new Map();
  /** When each job's current cron task was created (see getScheduledSince). */
  private scheduledSince: Map<string, Date> = new Map();
  private activeJobs: Set<string> = new Set();
  private currentConfig: SchedulerConfig | null = null;
  private catchupQueue: CatchupQueue | null = null;
  /** Retries already queued per "<jobId>@<slot ISO>" (deferred runs, see afterRun). */
  private deferredRetries: Map<string, number> = new Map();
  private draining = false;
  private drainedHandler: (() => void) | null = null;
  /**
   * The usage hold (2026-10-16): after a run reported the account's usage limit, no job that
   * starts a Claude session starts before `until`. Persisted in data/usage-hold.json so a
   * restart (a deploy's drain) keeps it; loaded here. See usage-limit.ts for the text.
   */
  private usageHold: UsageHold | null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.usageHold = readUsageHold(projectRoot);
    if (this.usageHold) {
      console.log(
        `[hold] Loaded usage hold from disk: ${this.usageHold.kind} limit, Claude jobs held until ${this.usageHold.until}`,
      );
    }
  }

  /** The hold, if it is still running; an expired one is dropped (and its file removed) here. */
  usageHoldActive(now: number = Date.now()): UsageHold | null {
    const hold = this.usageHold;
    if (!hold) return null;
    if (Date.parse(hold.until) <= now) {
      console.log(
        `[hold] Usage window reopened: the ${hold.kind} limit's reset (${hold.until}) has passed; ${hold.skipped} tick(s) were skipped`,
      );
      this.usageHold = null;
      removeUsageHold(this.projectRoot);
      return null;
    }
    return hold;
  }

  /** Claude-type jobs always; scripts only when scheduler.yaml says `uses_claude: true`. */
  private jobUsesClaude(jobConfig: JobConfig): boolean {
    return jobConfig.type !== "script" || jobConfig.uses_claude === true;
  }

  private heldJob(jobConfig: JobConfig, now: number = Date.now()): UsageHold | null {
    if (!this.jobUsesClaude(jobConfig)) return null;
    return this.usageHoldActive(now);
  }

  /** For the catch-up queue: the hold's end (ms) while `jobId` is held, else null. */
  holdUntilMsFor(jobId: string, now: number = Date.now()): number | null {
    const jobConfig = this.currentConfig?.jobs[jobId];
    if (!jobConfig) return null;
    const hold = this.heldJob(jobConfig, now);
    return hold ? Date.parse(hold.until) : null;
  }

  /**
   * Start (or extend) the hold after `runId` of `jobId` reported the limit. A hold already
   * ending later is kept; an earlier one is moved to the new reset.
   */
  private setUsageHold(hit: UsageLimitHit, jobId: string, runId: string): void {
    const now = new Date();
    const until = holdUntil(hit, now);
    const current = this.usageHoldActive(now.getTime());
    if (current && Date.parse(current.until) >= until.getTime()) {
      console.log(
        `[hold] ${jobId}/${runId} hit the ${hit.kind} limit again; hold already runs until ${current.until}`,
      );
      return;
    }
    this.usageHold = {
      version: 1,
      kind: hit.kind,
      until: until.toISOString(),
      since: current?.since ?? now.toISOString(),
      text: hit.text,
      skipped: current?.skipped ?? 0,
      jobId,
      runId,
    };
    writeUsageHold(this.projectRoot, this.usageHold);
    console.error(
      `[hold] ${jobId}/${runId}: "${hit.text}". Jobs that start a Claude session are held until ${this.usageHold.until}` +
        (hit.resetsAt ? "" : " (reset not understood: checked again then)"),
    );
  }

  /** POST /api/usage-hold/clear: Adam bought more usage or the text was wrong. */
  clearUsageHold(): boolean {
    const had = this.usageHold !== null;
    this.usageHold = null;
    removeUsageHold(this.projectRoot);
    if (had) {
      console.log("[hold] Usage hold cleared by request");
      this.catchupQueue?.process();
    }
    return had;
  }

  getUsageHold(): UsageHold | null {
    return this.usageHoldActive();
  }

  private skipForHold(jobId: string, hold: UsageHold): void {
    hold.skipped += 1;
    writeUsageHold(this.projectRoot, hold);
    console.warn(
      `[cron] Skipping ${jobId} — the Claude account's ${hold.kind} usage limit is exhausted until ${hold.until} (${hold.skipped} skipped so far)`,
    );
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

    // Add or update jobs. A draining daemon schedules nothing new: it is on its way out.
    for (const [jobId, jobConfig] of Object.entries(config.jobs)) {
      if (!jobConfig.enabled || this.draining) continue;

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

  private runOptions(
    jobId: string,
    jobConfig: JobConfig,
    config: SchedulerConfig,
    trigger: TriggerType,
  ) {
    return {
      jobId,
      jobConfig,
      projectRoot: this.projectRoot,
      trigger,
      defaultTimeout: config.defaults.timeout,
      maxRetries: jobConfig.max_retries ?? config.defaults.max_retries,
      priority: jobConfig.priority ?? config.defaults.priority,
      host: config.host?.name,
    };
  }

  /**
   * After a run: the evaluation (Haiku/Jev as configured; a deferred run is rated ok by the
   * scheduler itself without any model call), the retry of a deferred slot, and the pruner.
   * A deferred slot is retried after the job's `retry_after` (default 10 min), twice at most;
   * a manual run has no slot and is not retried (trigger it again instead).
   */
  private afterRun(
    jobId: string,
    jobConfig: JobConfig,
    config: SchedulerConfig,
    result: Awaited<ReturnType<typeof runJob>>,
    slot: Date | null,
  ): void {
    const evaluatorOptions = {
      decisionMode: this.currentConfig?.evaluator?.decision_model ?? "off",
      logRetainMonths: this.currentConfig?.evaluator?.log_retain_months,
    };
    if (result.status === "deferred") {
      evaluateDeferredRun(this.projectRoot, jobId, result.runId, jobConfig.name, evaluatorOptions);
      this.scheduleRetry(jobId, jobConfig, result.runId, slot);
    } else if (result.status === "blocked" && result.usageLimit) {
      // The account's usage window is exhausted: rate the run without a model (the limit line
      // says it all) and hold this Mac's Claude jobs until the reset. No retry, no catch-up.
      this.setUsageHold(result.usageLimit, jobId, result.runId);
      evaluateUsageLimitedRun(
        this.projectRoot,
        jobId,
        result.runId,
        jobConfig.name,
        result.usageLimit,
        this.usageHold?.until ?? null,
        evaluatorOptions,
      );
    } else {
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
        evaluatorOptions,
      ).catch((err) =>
        console.error(`[eval] ${jobId}: evaluation failed:`, err),
      );
    }
    pruneOldRuns(this.projectRoot, jobId, config.defaults.retain_runs);
  }

  private scheduleRetry(
    jobId: string,
    jobConfig: JobConfig,
    runId: string,
    slot: Date | null,
  ): void {
    if (!slot) {
      console.log(`[cron] ${jobId}: run ${runId} deferred by its precondition (manual run: not retried)`);
      return;
    }
    const now = Date.now();
    for (const [key, _count] of this.deferredRetries) {
      const slotMs = Date.parse(key.slice(key.indexOf("@") + 1));
      if (!Number.isFinite(slotMs) || now - slotMs > RETRY_MEMORY_MS) this.deferredRetries.delete(key);
    }
    const key = `${jobId}@${slot.toISOString()}`;
    const retries = this.deferredRetries.get(key) ?? 0;
    if (retries >= DEFERRED_RETRY.maxRetries || !this.catchupQueue) {
      console.log(
        `[cron] ${jobId}: run ${runId} deferred by its precondition; slot ${slot.toISOString()} already retried ${retries} time(s), giving up until the next slot`,
      );
      return;
    }
    const retryAfterSec = jobConfig.retry_after ?? DEFERRED_RETRY.retryAfterSec;
    this.deferredRetries.set(key, retries + 1);
    console.log(
      `[cron] ${jobId}: run ${runId} deferred by its precondition; retry ${retries + 1} of ${DEFERRED_RETRY.maxRetries} in ${retryAfterSec}s`,
    );
    this.catchupQueue.enqueueRetry(jobId, slot, {
      retry: retries + 1,
      notBefore: new Date(now + retryAfterSec * 1000),
      afterStartedAt: new Date(now).toISOString(),
    });
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
    if (this.draining) {
      console.warn(`[cron] Skipping ${jobId} — the daemon is draining`);
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
    const hold = this.heldJob(jobConfig);
    if (hold) {
      // No run directory (the pruner would evict real history), one log line, and the slot
      // queued under the job's own catchup policy; the queue keeps it until the hold ends.
      this.skipForHold(jobId, hold);
      this.catchupQueue?.enqueue(jobId, slot);
      return;
    }

    this.activeJobs.add(jobId);
    console.log(`[cron] Starting scheduled run: ${jobId}`);

    try {
      const result = await runJob({
        ...this.runOptions(jobId, jobConfig, config, "scheduled"),
        slot: slot.toISOString(),
      });
      this.afterRun(jobId, jobConfig, config, result, slot);
    } catch (err) {
      console.error(`[cron] Error running ${jobId}:`, err);
    } finally {
      this.finishRun(jobId);
    }
  }

  private finishRun(jobId: string): void {
    this.activeJobs.delete(jobId);
    this.catchupQueue?.process();
    if (this.draining && this.activeJobs.size === 0) this.drainedHandler?.();
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
    if (this.draining) {
      return { error: "The daemon is draining; no new runs start until it restarts" };
    }
    const hold = this.heldJob(jobConfig);
    if (hold) {
      return {
        error: `The Claude account's ${hold.kind} usage limit is exhausted; jobs that start a Claude session are held until ${hold.until} (POST /api/usage-hold/clear to override)`,
      };
    }

    this.activeJobs.add(jobId);
    const config = this.currentConfig;

    try {
      const result = await runJob(this.runOptions(jobId, jobConfig, config, "manual"));
      this.afterRun(jobId, jobConfig, config, result, null);
      return { runId: result.runId };
    } finally {
      this.finishRun(jobId);
    }
  }

  setCatchupQueue(queue: CatchupQueue): void {
    this.catchupQueue = queue;
  }

  getCatchupQueue(): CatchupQueue | null {
    return this.catchupQueue;
  }

  /**
   * A catch-up of a missed slot or, with `options.kind === "retry"`, the retry of a slot whose
   * run was deferred (same slot, trigger `catchup`, meta.deferredRetry says which retry).
   */
  async runCatchup(
    jobId: string,
    missedSlot: Date,
    options: QueueRunOptions = { kind: "catchup" },
  ): Promise<{ runId: string } | { error: string }> {
    if (!this.currentConfig) return { error: "No config loaded" };
    const jobConfig = this.currentConfig.jobs[jobId];
    if (!jobConfig) return { error: `Job not found: ${jobId}` };
    if (this.activeJobs.has(jobId))
      return { error: `Job already running: ${jobId}` };
    if (this.draining) return { error: "The daemon is draining" };
    // The queue keeps held entries (holdUntil dep); this is the backstop for a direct call.
    const hold = this.heldJob(jobConfig);
    if (hold) return { error: `Claude jobs are held until ${hold.until} (${hold.kind} usage limit)` };

    this.activeJobs.add(jobId);
    const config = this.currentConfig;
    try {
      const result = await runJob({
        ...this.runOptions(jobId, jobConfig, config, "catchup"),
        catchupFor: missedSlot.toISOString(),
        slot: missedSlot.toISOString(),
        ...(options.kind === "retry" && options.retry !== undefined
          ? { deferredRetry: options.retry }
          : {}),
      });
      this.afterRun(jobId, jobConfig, config, result, missedSlot);
      return { runId: result.runId };
    } finally {
      this.finishRun(jobId);
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

  /**
   * Stop starting runs (cron ticks, catch-ups, manual triggers) and let the running ones
   * finish; `onDrained` fires once none are left (at once when none is running). Used by
   * POST /api/drain so a deploy never kills a run (2026-10-16). Returns the jobs still running.
   */
  drain(): string[] {
    if (!this.draining) {
      this.draining = true;
      this.stopAll();
      this.catchupQueue?.pause();
      console.log(
        `[cron] Draining: ${this.activeJobs.size === 0 ? "no run in progress" : `waiting for ${[...this.activeJobs].join(", ")}`}`,
      );
    }
    const running = this.getActiveJobIds();
    if (running.length === 0) queueMicrotask(() => this.drainedHandler?.());
    return running;
  }

  isDraining(): boolean {
    return this.draining;
  }

  onDrained(handler: () => void): void {
    this.drainedHandler = handler;
  }

  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    this.scheduledSince.clear();
  }
}
