import { z } from "zod";

const jobSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  directory: z.string(),
  prompt: z.string(),
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  timeout: z.number().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
  skip_permissions: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
});

const defaultsSchema = z.object({
  timeout: z.number().positive().default(300),
  max_retries: z.number().int().min(0).default(0),
  retain_runs: z.number().int().positive().default(50),
});

export const configSchema = z.object({
  version: z.literal(1),
  defaults: defaultsSchema.default({
    timeout: 300,
    max_retries: 0,
    retain_runs: 50,
  }),
  jobs: z.record(z.string(), jobSchema),
});

export type SchedulerConfig = z.infer<typeof configSchema>;
export type JobConfig = z.infer<typeof jobSchema>;
