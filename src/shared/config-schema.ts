import { z } from "zod";

const jobSchema = z
  .object({
    name: z.string(),
    schedule: z.string(),
    directory: z.string(),
    type: z.enum(["claude", "script"]).default("claude"),
    prompt: z.string().optional(),
    command: z.string().optional(),
    enabled: z.boolean().default(true),
    model: z.string().optional(),
    timeout: z.number().positive().optional(),
    max_retries: z.number().int().min(0).optional(),
    // "same-day": skip a catch-up that would start on a later local date than the missed
    // slot (for jobs that act on "today"/"tomorrow"). Unset behaves as "always".
    catchup: z.enum(["always", "same-day", "never"]).optional(),
    // Per-job override of defaults.priority (see JobPriority in types.ts).
    priority: z.enum(["background", "normal"]).optional(),
    skip_permissions: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    // Which host role(s) schedule this job (see `hosts`): a role name, a list of them, or
    // "all". Required once `hosts` is declared, so a job never runs on two Macs by accident.
    runs_on: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  })
  .refine(
    (job) => {
      if (job.type === "claude") return !!job.prompt;
      if (job.type === "script") return !!job.command;
      return true;
    },
    {
      message: "Claude jobs require 'prompt', script jobs require 'command'",
    },
  );

const defaultsSchema = z.object({
  timeout: z.number().positive().default(300),
  max_retries: z.number().int().min(0).default(0),
  retain_runs: z.number().int().positive().default(50),
  // "background": jobs yield CPU/IO to interactive work (taskpolicy on macOS, nice elsewhere).
  priority: z.enum(["background", "normal"]).default("background"),
});

// Post-run evaluator: whether and how the Jev decision model (TypeSafe System One) takes part.
// off = Haiku only (default); shadow = Haiku decides, Jev recorded beside it; enforce = Jev decides;
// benchmark = Jev decides as in enforce, and Haiku still judges every run, recorded beside it.
const evaluatorSchema = z.object({
  decision_model: z
    .enum(["off", "shadow", "enforce", "benchmark"])
    .default("off"),
  // Months of data/evaluations/YYYY-MM.jsonl to keep; about 3 MB per month at 60 runs a day.
  log_retain_months: z.number().int().min(1).max(120).default(12),
});

// Role names double as runs_on values; keep them shell- and YAML-safe.
const roleName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only");

// A host is a bare role name, or an object that also says how to reach it for the Hosts
// page's health check: `ssh` is an alias from ~/.ssh/config on the Mac running the UI.
const hostEntry = z.union([
  roleName,
  z.object({ role: roleName, ssh: z.string().min(1).optional() }),
]);
export type HostEntry = z.infer<typeof hostEntry>;

export function hostRole(entry: HostEntry): string {
  return typeof entry === "string" ? entry : entry.role;
}

export function hostSsh(entry: HostEntry): string | undefined {
  return typeof entry === "string" ? undefined : entry.ssh;
}

export const configSchema = z
  .object({
    version: z.literal(1),
    defaults: defaultsSchema.default({
      timeout: 300,
      max_retries: 0,
      retain_runs: 50,
      priority: "background",
    }),
    evaluator: evaluatorSchema.optional(),
    // One scheduler.yaml for several Macs (2026-10-15): host name (the Mac's
    // LocalHostName, see localHostName in daemon/config.ts) -> role. A daemon schedules only the jobs whose runs_on names its own role.
    hosts: z.record(z.string(), hostEntry).optional(),
    jobs: z.record(z.string(), jobSchema),
  })
  .superRefine((config, ctx) => {
    if (!config.hosts || Object.keys(config.hosts).length === 0) return;
    const roles = new Set(Object.values(config.hosts).map(hostRole));
    for (const [id, job] of Object.entries(config.jobs)) {
      if (job.runs_on === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["jobs", id, "runs_on"],
          message: `required when 'hosts' is declared: one of ${[...roles].join(", ")}, a list of them, or "all"`,
        });
        continue;
      }
      for (const role of runsOnList(job.runs_on)) {
        if (role !== "all" && !roles.has(role)) {
          ctx.addIssue({
            code: "custom",
            path: ["jobs", id, "runs_on"],
            message: `unknown role "${role}"; declared: ${[...roles].join(", ")}`,
          });
        }
      }
    }
  });

/** The machine the daemon resolved from `hosts` at load time. Not part of the YAML. */
export interface HostInfo {
  name: string;
  role: string;
}

export type SchedulerConfig = z.infer<typeof configSchema> & { host?: HostInfo };
export type JobConfig = z.infer<typeof jobSchema>;

export function runsOnList(runsOn: string | string[]): string[] {
  return Array.isArray(runsOn) ? runsOn : [runsOn];
}

/** Without runs_on (single-machine configs) a job runs everywhere. */
export function jobRunsOnRole(job: Pick<JobConfig, "runs_on">, role: string): boolean {
  if (job.runs_on === undefined) return true;
  return runsOnList(job.runs_on).some((r) => r === "all" || r === role);
}
