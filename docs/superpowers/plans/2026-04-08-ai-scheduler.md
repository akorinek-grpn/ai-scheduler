# AI Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local tool that schedules and monitors Claude CLI runs across multiple projects, with a web dashboard and Claude Code skill for management.

**Architecture:** Three components communicating via filesystem. A standalone scheduler daemon manages cron jobs and spawns `claude -p` processes. A Next.js web UI reads run data and proxies triggers. A Claude Code skill manages the config YAML conversationally.

**Tech Stack:** Node.js, TypeScript, Express, node-cron, js-yaml, Zod, Next.js 15, React, shadcn/ui, Tailwind CSS

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.daemon.json`
- Create: `.gitignore`
- Create: `scheduler.yaml`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/akorinek/Programming/ai-scheduler
npm init -y
```

Then edit `package.json`:

```json
{
  "name": "ai-scheduler",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "daemon": "tsx src/daemon/index.ts",
    "daemon:watch": "tsx watch src/daemon/index.ts",
    "dev": "next dev --port 3500 --turbopack",
    "build": "next build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Install daemon dependencies**

```bash
npm install express node-cron js-yaml zod crypto-random-string
npm install -D typescript tsx @types/node @types/express @types/node-cron @types/js-yaml vitest
```

- [ ] **Step 3: Install Next.js + shadcn/ui dependencies**

```bash
npm install next react react-dom
npm install -D @types/react @types/react-dom tailwindcss @tailwindcss/postcss postcss
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "incremental": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/web/*"],
      "@shared/*": ["./src/shared/*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create tsconfig.daemon.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "paths": {
      "@shared/*": ["./src/shared/*"]
    }
  },
  "include": ["src/daemon/**/*.ts", "src/shared/**/*.ts"]
}
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
.next/
data/
.superpowers/
*.tsbuildinfo
next-env.d.ts
.env
.env.local
```

- [ ] **Step 7: Create next.config.ts**

Create `next.config.ts`:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["js-yaml"],
  },
};

export default nextConfig;
```

- [ ] **Step 8: Create postcss.config.mjs**

```javascript
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 9: Create starter scheduler.yaml**

```yaml
version: 1

defaults:
  timeout: 300
  max_retries: 0
  retain_runs: 50

jobs: {}
```

- [ ] **Step 10: Create data directory**

```bash
mkdir -p data/runs
```

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json tsconfig.daemon.json .gitignore next.config.ts postcss.config.mjs scheduler.yaml
git commit -m "chore: scaffold project with daemon + Next.js setup"
```

---

### Task 2: Shared Types and Config Schema

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/config-schema.ts`
- Create: `src/shared/paths.ts`
- Create: `src/shared/__tests__/config-schema.test.ts`
- Create: `src/shared/__tests__/paths.test.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
});
```

- [ ] **Step 2: Write failing tests for config schema**

Create `src/shared/__tests__/config-schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { configSchema, type SchedulerConfig } from "@shared/config-schema";

describe("configSchema", () => {
  it("parses a valid full config", () => {
    const input = {
      version: 1,
      defaults: {
        timeout: 300,
        max_retries: 0,
        retain_runs: 50,
      },
      jobs: {
        "review-prs": {
          name: "Review Open PRs",
          schedule: "0 9 * * 1-5",
          directory: "/Users/test/repo",
          prompt: "Review all open PRs",
          enabled: true,
          timeout: 600,
          tags: ["code-review", "daily"],
        },
      },
    };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobs["review-prs"].name).toBe("Review Open PRs");
    }
  });

  it("applies defaults for optional fields", () => {
    const input = {
      version: 1,
      jobs: {
        "my-job": {
          name: "My Job",
          schedule: "0 9 * * *",
          directory: "/tmp/test",
          prompt: "Do something",
        },
      },
    };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.timeout).toBe(300);
      expect(result.data.defaults.max_retries).toBe(0);
      expect(result.data.defaults.retain_runs).toBe(50);
      expect(result.data.jobs["my-job"].enabled).toBe(true);
    }
  });

  it("rejects config without version", () => {
    const input = { jobs: {} };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects job missing required fields", () => {
    const input = {
      version: 1,
      jobs: {
        bad: {
          name: "Bad Job",
        },
      },
    };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("accepts empty jobs object", () => {
    const input = { version: 1, jobs: {} };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/shared/__tests__/config-schema.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement types.ts**

Create `src/shared/types.ts`:

```typescript
export type RunStatus = "running" | "success" | "failed" | "timeout";
export type TriggerType = "scheduled" | "manual";

export interface JobConfig {
  name: string;
  schedule: string;
  directory: string;
  prompt: string;
  enabled: boolean;
  model?: string;
  timeout?: number;
  max_retries?: number;
  tags: string[];
}

export interface SchedulerDefaults {
  timeout: number;
  max_retries: number;
  retain_runs: number;
}

export interface SchedulerConfig {
  version: number;
  defaults: SchedulerDefaults;
  jobs: Record<string, JobConfig>;
}

export interface RunMeta {
  jobId: string;
  runId: string;
  jobConfig: JobConfig;
  trigger: TriggerType;
  startedAt: string;
}

export interface RunStatusFile {
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DaemonHealth {
  status: "running" | "stopped";
  pid: number;
  port: number;
  startedAt: string;
  lastHeartbeat: string;
  activeJobs: string[];
}

export interface RunSummary {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: RunStatus;
  trigger: TriggerType;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}
```

- [ ] **Step 5: Implement config-schema.ts**

Create `src/shared/config-schema.ts`:

```typescript
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
```

- [ ] **Step 6: Run config schema tests**

```bash
npx vitest run src/shared/__tests__/config-schema.test.ts
```

Expected: PASS

- [ ] **Step 7: Write failing tests for paths.ts**

Create `src/shared/__tests__/paths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getRunDir, getJobDir, getLogPath, getStatusPath, getMetaPath, getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = "/Users/test/ai-scheduler";

describe("paths", () => {
  it("getRunDir returns correct path", () => {
    const result = getRunDir(PROJECT_ROOT, "my-job", "2026-04-08T09-00-00-abc123");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/2026-04-08T09-00-00-abc123"));
  });

  it("getJobDir returns correct path", () => {
    const result = getJobDir(PROJECT_ROOT, "my-job");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job"));
  });

  it("getLogPath returns output.log inside run dir", () => {
    const result = getLogPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/output.log"));
  });

  it("getStatusPath returns status.json inside run dir", () => {
    const result = getStatusPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/status.json"));
  });

  it("getMetaPath returns meta.json inside run dir", () => {
    const result = getMetaPath(PROJECT_ROOT, "my-job", "run-1");
    expect(result).toBe(path.join(PROJECT_ROOT, "data/runs/my-job/run-1/meta.json"));
  });

  it("getDaemonJsonPath returns data/daemon.json", () => {
    const result = getDaemonJsonPath(PROJECT_ROOT);
    expect(result).toBe(path.join(PROJECT_ROOT, "data/daemon.json"));
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

```bash
npx vitest run src/shared/__tests__/paths.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 9: Implement paths.ts**

Create `src/shared/paths.ts`:

```typescript
import path from "path";

export function getDataDir(projectRoot: string): string {
  return path.join(projectRoot, "data");
}

export function getRunsDir(projectRoot: string): string {
  return path.join(projectRoot, "data", "runs");
}

export function getJobDir(projectRoot: string, jobId: string): string {
  return path.join(projectRoot, "data", "runs", jobId);
}

export function getRunDir(projectRoot: string, jobId: string, runId: string): string {
  return path.join(projectRoot, "data", "runs", jobId, runId);
}

export function getLogPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "output.log");
}

export function getStatusPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "status.json");
}

export function getMetaPath(projectRoot: string, jobId: string, runId: string): string {
  return path.join(getRunDir(projectRoot, jobId, runId), "meta.json");
}

export function getDaemonJsonPath(projectRoot: string): string {
  return path.join(projectRoot, "data", "daemon.json");
}

export function getLatestSymlink(projectRoot: string, jobId: string): string {
  return path.join(getJobDir(projectRoot, jobId), "latest");
}
```

- [ ] **Step 10: Run all shared tests**

```bash
npx vitest run src/shared/
```

Expected: PASS (all tests)

- [ ] **Step 11: Commit**

```bash
git add src/shared/ vitest.config.ts
git commit -m "feat: add shared types, config schema, and path helpers"
```

---

### Task 3: Config Loader (YAML → validated config)

**Files:**
- Create: `src/daemon/config.ts`
- Create: `src/daemon/__tests__/config.test.ts`

- [ ] **Step 1: Write failing tests for config loader**

Create `src/daemon/__tests__/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config";
import fs from "fs";
import path from "path";
import os from "os";

describe("loadConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-test-"));
    configPath = path.join(tmpDir, "scheduler.yaml");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and parses a valid YAML config", () => {
    fs.writeFileSync(
      configPath,
      `version: 1
defaults:
  timeout: 600
jobs:
  test-job:
    name: "Test Job"
    schedule: "0 9 * * *"
    directory: /tmp/test
    prompt: "Do the thing"
`
    );
    const result = loadConfig(configPath);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobs["test-job"].name).toBe("Test Job");
      expect(result.data.defaults.timeout).toBe(600);
      expect(result.data.defaults.retain_runs).toBe(50);
    }
  });

  it("returns error for invalid YAML", () => {
    fs.writeFileSync(configPath, ":::invalid yaml:::");
    const result = loadConfig(configPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("returns error for missing file", () => {
    const result = loadConfig("/nonexistent/scheduler.yaml");
    expect(result.success).toBe(false);
  });

  it("returns error for schema validation failure", () => {
    fs.writeFileSync(
      configPath,
      `version: 2
jobs: {}
`
    );
    const result = loadConfig(configPath);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/daemon/__tests__/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement config.ts**

Create `src/daemon/config.ts`:

```typescript
import fs from "fs";
import yaml from "js-yaml";
import { configSchema, type SchedulerConfig } from "@shared/config-schema";

interface ConfigSuccess {
  success: true;
  data: SchedulerConfig;
}

interface ConfigError {
  success: false;
  error: string;
}

export type ConfigResult = ConfigSuccess | ConfigError;

export function loadConfig(configPath: string): ConfigResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    return {
      success: false,
      error: `Failed to read config file: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      success: false,
      error: `Invalid YAML: ${(err as Error).message}`,
    };
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: `Config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
    };
  }

  return { success: true, data: result.data };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/daemon/__tests__/config.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/config.ts src/daemon/__tests__/config.test.ts
git commit -m "feat: add YAML config loader with Zod validation"
```

---

### Task 4: Job Runner (spawns Claude CLI)

**Files:**
- Create: `src/daemon/job-runner.ts`
- Create: `src/daemon/__tests__/job-runner.test.ts`

- [ ] **Step 1: Write failing tests for job runner**

Create `src/daemon/__tests__/job-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runJob } from "../job-runner";
import fs from "fs";
import path from "path";
import os from "os";
import type { JobConfig, TriggerType } from "@shared/types";

describe("runJob", () => {
  let tmpDir: string;

  const testJob: JobConfig = {
    name: "Test Job",
    schedule: "0 9 * * *",
    directory: os.tmpdir(),
    prompt: "echo hello",
    enabled: true,
    tags: [],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-runner-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates run directory with meta.json and status.json", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello world"],
    });

    expect(run.runId).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    expect(fs.existsSync(path.join(runDir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "status.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "output.log"))).toBe(true);

    const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
    expect(meta.jobId).toBe("test-job");
    expect(meta.trigger).toBe("manual");

    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("success");
    expect(status.exitCode).toBe(0);
  });

  it("captures command output to output.log", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "scheduled",
      command: "echo",
      args: ["test output line"],
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const log = fs.readFileSync(path.join(runDir, "output.log"), "utf-8");
    expect(log).toContain("test output line");
  });

  it("marks failed run with correct exit code", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "sh",
      args: ["-c", "exit 1"],
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(1);
  });

  it("creates latest symlink pointing to run dir", async () => {
    const run = await runJob({
      jobId: "test-job",
      jobConfig: testJob,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "echo",
      args: ["hello"],
    });

    const latestPath = path.join(tmpDir, "data", "runs", "test-job", "latest");
    expect(fs.lstatSync(latestPath).isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(latestPath);
    expect(target).toBe(run.runId);
  });

  it("times out a long-running process", async () => {
    const jobWithTimeout: JobConfig = { ...testJob, timeout: 1 };
    const run = await runJob({
      jobId: "test-job",
      jobConfig: jobWithTimeout,
      projectRoot: tmpDir,
      trigger: "manual",
      command: "sleep",
      args: ["30"],
      defaultTimeout: 1,
    });

    const runDir = path.join(tmpDir, "data", "runs", "test-job", run.runId);
    const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
    expect(status.status).toBe("timeout");
  }, 10000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/daemon/__tests__/job-runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement job-runner.ts**

Create `src/daemon/job-runner.ts`:

```typescript
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { JobConfig, TriggerType, RunMeta, RunStatusFile } from "@shared/types";
import { getRunDir, getJobDir, getLogPath, getStatusPath, getMetaPath, getLatestSymlink } from "@shared/paths";

interface RunJobOptions {
  jobId: string;
  jobConfig: JobConfig;
  projectRoot: string;
  trigger: TriggerType;
  command?: string;
  args?: string[];
  defaultTimeout?: number;
}

interface RunResult {
  runId: string;
  status: "success" | "failed" | "timeout";
  exitCode: number | null;
}

function generateRunId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hash = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${hash}`;
}

export async function runJob(options: RunJobOptions): Promise<RunResult> {
  const { jobId, jobConfig, projectRoot, trigger, defaultTimeout = 300 } = options;
  const runId = generateRunId();
  const runDir = getRunDir(projectRoot, jobId, runId);

  fs.mkdirSync(runDir, { recursive: true });

  const meta: RunMeta = {
    jobId,
    runId,
    jobConfig,
    trigger,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getMetaPath(projectRoot, jobId, runId), JSON.stringify(meta, null, 2));

  const statusFile: RunStatusFile = {
    status: "running",
    exitCode: null,
    startedAt: meta.startedAt,
    finishedAt: null,
  };
  fs.writeFileSync(getStatusPath(projectRoot, jobId, runId), JSON.stringify(statusFile, null, 2));

  const logPath = getLogPath(projectRoot, jobId, runId);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const command = options.command ?? "claude";
  const args = options.args ?? ["-p", "--print", jobConfig.prompt, ...(jobConfig.model ? ["--model", jobConfig.model] : [])];

  const timeout = jobConfig.timeout ?? defaultTimeout;

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: jobConfig.directory,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    let isTimedOut = false;
    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, timeout * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      logStream.end();

      const finalStatus: RunStatusFile = {
        status: isTimedOut ? "timeout" : code === 0 ? "success" : "failed",
        exitCode: code,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(getStatusPath(projectRoot, jobId, runId), JSON.stringify(finalStatus, null, 2));

      // Update latest symlink
      const symlinkPath = getLatestSymlink(projectRoot, jobId);
      try {
        fs.unlinkSync(symlinkPath);
      } catch {
        // symlink doesn't exist yet
      }
      fs.symlinkSync(runId, symlinkPath);

      resolve({
        runId,
        status: finalStatus.status as RunResult["status"],
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      logStream.write(`\nProcess error: ${err.message}\n`);
      logStream.end();

      const finalStatus: RunStatusFile = {
        status: "failed",
        exitCode: null,
        startedAt: meta.startedAt,
        finishedAt: new Date().toISOString(),
      };
      fs.writeFileSync(getStatusPath(projectRoot, jobId, runId), JSON.stringify(finalStatus, null, 2));

      const symPath = getLatestSymlink(projectRoot, jobId);
      try { fs.unlinkSync(symPath); } catch { /* noop */ }
      fs.symlinkSync(runId, symPath);

      resolve({ runId, status: "failed", exitCode: null });
    });
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/daemon/__tests__/job-runner.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/job-runner.ts src/daemon/__tests__/job-runner.test.ts
git commit -m "feat: add job runner that spawns CLI processes and captures output"
```

---

### Task 5: Cron Engine (scheduling + config watching)

**Files:**
- Create: `src/daemon/cron-engine.ts`
- Create: `src/daemon/__tests__/cron-engine.test.ts`

- [ ] **Step 1: Write failing tests for cron engine**

Create `src/daemon/__tests__/cron-engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronEngine } from "../cron-engine";
import fs from "fs";
import path from "path";
import os from "os";
import type { SchedulerConfig } from "@shared/config-schema";

describe("CronEngine", () => {
  let tmpDir: string;
  let configPath: string;

  const makeConfig = (jobs: SchedulerConfig["jobs"]): SchedulerConfig => ({
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50 },
    jobs,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-cron-"));
    configPath = path.join(tmpDir, "scheduler.yaml");
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers jobs from config", () => {
    const config = makeConfig({
      "test-job": {
        name: "Test",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: true,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);

    expect(engine.getRegisteredJobIds()).toEqual(["test-job"]);
    engine.stopAll();
  });

  it("skips disabled jobs", () => {
    const config = makeConfig({
      "disabled-job": {
        name: "Disabled",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: false,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config);

    expect(engine.getRegisteredJobIds()).toEqual([]);
    engine.stopAll();
  });

  it("tracks active jobs", () => {
    const engine = new CronEngine(tmpDir);
    expect(engine.getActiveJobIds()).toEqual([]);
    engine.stopAll();
  });

  it("removes jobs when config changes", () => {
    const config1 = makeConfig({
      "job-a": {
        name: "A",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "a",
        enabled: true,
        tags: [],
      },
      "job-b": {
        name: "B",
        schedule: "0 10 * * *",
        directory: "/tmp",
        prompt: "b",
        enabled: true,
        tags: [],
      },
    });

    const config2 = makeConfig({
      "job-a": {
        name: "A",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "a",
        enabled: true,
        tags: [],
      },
    });

    const engine = new CronEngine(tmpDir);
    engine.loadJobs(config1);
    expect(engine.getRegisteredJobIds().sort()).toEqual(["job-a", "job-b"]);

    engine.loadJobs(config2);
    expect(engine.getRegisteredJobIds()).toEqual(["job-a"]);

    engine.stopAll();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/daemon/__tests__/cron-engine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement cron-engine.ts**

Create `src/daemon/cron-engine.ts`:

```typescript
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
      const scheduleChanged = existingSchedule !== jobConfig.schedule;

      if (this.tasks.has(jobId) && !scheduleChanged) continue;

      // Remove old task if schedule changed
      if (this.tasks.has(jobId)) {
        this.tasks.get(jobId)!.stop();
        this.tasks.delete(jobId);
      }

      const task = cron.schedule(jobConfig.schedule, () => {
        this.executeJob(jobId, jobConfig, config);
      });

      this.tasks.set(jobId, task);
    }

    this.currentConfig = config;
  }

  private async executeJob(jobId: string, jobConfig: JobConfig, config: SchedulerConfig): Promise<void> {
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/daemon/__tests__/cron-engine.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/cron-engine.ts src/daemon/__tests__/cron-engine.test.ts
git commit -m "feat: add cron engine with job scheduling and concurrency guard"
```

---

### Task 6: Daemon API (Express routes)

**Files:**
- Create: `src/daemon/api.ts`
- Create: `src/daemon/__tests__/api.test.ts`

- [ ] **Step 1: Write failing tests for daemon API**

Create `src/daemon/__tests__/api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import fs from "fs";
import path from "path";
import os from "os";
import type { SchedulerConfig } from "@shared/config-schema";
import type { RunStatusFile, RunMeta } from "@shared/types";

// Simple test helper to make requests against the express app
async function request(app: ReturnType<typeof createApp>, method: string, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${port}${url}`, { method })
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 500, body: { error: err.message } });
        });
    });
  });
}

describe("daemon API", () => {
  let tmpDir: string;
  let engine: CronEngine;

  const config: SchedulerConfig = {
    version: 1,
    defaults: { timeout: 300, max_retries: 0, retain_runs: 50 },
    jobs: {
      "test-job": {
        name: "Test Job",
        schedule: "0 9 * * *",
        directory: "/tmp",
        prompt: "hello",
        enabled: true,
        tags: ["daily"],
      },
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-api-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs", "test-job"), { recursive: true });
    engine = new CronEngine(tmpDir);
    engine.loadJobs(config);
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/health returns daemon status", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/health");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("running");
    expect(body.pid).toBe(process.pid);
  });

  it("GET /api/jobs returns job list", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>).id).toBe("test-job");
  });

  it("GET /api/runs returns empty list when no runs", async () => {
    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/runs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/runs returns runs from data directory", async () => {
    const runDir = path.join(tmpDir, "data", "runs", "test-job", "2026-04-08T09-00-00-abc123");
    fs.mkdirSync(runDir, { recursive: true });

    const meta: RunMeta = {
      jobId: "test-job",
      runId: "2026-04-08T09-00-00-abc123",
      jobConfig: config.jobs["test-job"],
      trigger: "scheduled",
      startedAt: "2026-04-08T09:00:00.000Z",
    };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));

    const status: RunStatusFile = {
      status: "success",
      exitCode: 0,
      startedAt: "2026-04-08T09:00:00.000Z",
      finishedAt: "2026-04-08T09:03:00.000Z",
    };
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
    fs.writeFileSync(path.join(runDir, "output.log"), "some output");

    const app = createApp(engine, tmpDir, new Date().toISOString());
    const res = await request(app, "GET", "/api/runs");
    expect(res.status).toBe(200);
    const runs = res.body as Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("test-job");
    expect(runs[0].status).toBe("success");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/daemon/__tests__/api.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement api.ts**

Create `src/daemon/api.ts`:

```typescript
import express from "express";
import fs from "fs";
import path from "path";
import { CronEngine } from "./cron-engine";
import { getRunsDir, getRunDir, getLogPath, getStatusPath, getMetaPath } from "@shared/paths";
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/daemon/__tests__/api.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api.ts src/daemon/__tests__/api.test.ts
git commit -m "feat: add daemon REST API with health, jobs, runs, and trigger endpoints"
```

---

### Task 7: Daemon Entry Point

**Files:**
- Create: `src/daemon/index.ts`
- Create: `scripts/start-daemon.sh`
- Create: `scripts/stop-daemon.sh`

- [ ] **Step 1: Implement daemon entry point**

Create `src/daemon/index.ts`:

```typescript
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
```

- [ ] **Step 2: Create start-daemon.sh**

Create `scripts/start-daemon.sh`:

```bash
#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_ROOT/data"
DAEMON_JSON="$DATA_DIR/daemon.json"

mkdir -p "$DATA_DIR"

# Check if daemon is already running
if [ -f "$DAEMON_JSON" ]; then
  PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).pid)" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Daemon already running (pid: $PID)"
    exit 0
  fi
  rm -f "$DAEMON_JSON"
fi

echo "Starting AI Scheduler daemon..."
nohup npx tsx "$PROJECT_ROOT/src/daemon/index.ts" >> "$DATA_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (pid: $DAEMON_PID)"

# Wait for daemon.json to appear
for i in $(seq 1 10); do
  if [ -f "$DAEMON_JSON" ]; then
    echo "Daemon ready on port $(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).port)")"
    exit 0
  fi
  sleep 0.5
done

echo "Warning: Daemon started but daemon.json not yet written"
```

- [ ] **Step 3: Create stop-daemon.sh**

Create `scripts/stop-daemon.sh`:

```bash
#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DAEMON_JSON="$PROJECT_ROOT/data/daemon.json"

if [ ! -f "$DAEMON_JSON" ]; then
  echo "No daemon.json found — daemon not running"
  exit 0
fi

PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).pid)" 2>/dev/null || true)

if [ -z "$PID" ]; then
  echo "Could not read PID from daemon.json"
  rm -f "$DAEMON_JSON"
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping daemon (pid: $PID)..."
  kill "$PID"
  # Wait for clean shutdown
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Daemon stopped"
      exit 0
    fi
    sleep 0.5
  done
  echo "Force killing daemon..."
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$DAEMON_JSON"
else
  echo "Daemon not running (stale daemon.json)"
  rm -f "$DAEMON_JSON"
fi
```

- [ ] **Step 4: Make scripts executable**

```bash
chmod +x scripts/start-daemon.sh scripts/stop-daemon.sh
```

- [ ] **Step 5: Test daemon starts and stops**

```bash
cd /Users/akorinek/Programming/ai-scheduler
./scripts/start-daemon.sh
curl -s http://127.0.0.1:3501/api/health | head -1
./scripts/stop-daemon.sh
```

Expected: Health endpoint returns JSON with `"status":"running"`, daemon stops cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/index.ts scripts/
git commit -m "feat: add daemon entry point with config watching and lifecycle scripts"
```

---

### Task 8: Next.js App Shell + shadcn/ui Setup

**Files:**
- Create: `src/web/app/globals.css`
- Create: `src/web/app/layout.tsx`
- Create: `src/web/app/page.tsx`
- Create: `src/web/components/sidebar.tsx`
- Create: `src/web/lib/api-client.ts`

- [ ] **Step 1: Initialize shadcn/ui**

```bash
cd /Users/akorinek/Programming/ai-scheduler
npx shadcn@latest init -d --src-dir src/web
```

Follow prompts: style=new-york, base color=zinc, css variables=yes.

- [ ] **Step 2: Add shadcn components**

```bash
npx shadcn@latest add badge button card table tabs --src-dir src/web
```

- [ ] **Step 3: Create globals.css**

Create `src/web/app/globals.css`:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

:root {
  --radius: 0.625rem;
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.145 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.145 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.985 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.396 0.141 25.723);
  --border: oklch(0.269 0 0);
  --input: oklch(0.269 0 0);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.145 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(0.269 0 0);
  --sidebar-ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

Note: The exact CSS will depend on what shadcn init generates. Use the generated output and ensure dark mode is the default. If shadcn generates its own globals.css, use that and adjust.

- [ ] **Step 4: Create api-client.ts**

Create `src/web/lib/api-client.ts`:

```typescript
const DAEMON_API_BASE = "/api";

export interface HealthResponse {
  status: string;
  pid: number;
  startedAt: string;
  activeJobs: string[];
}

export interface JobResponse {
  id: string;
  name: string;
  schedule: string;
  directory: string;
  prompt: string;
  enabled: boolean;
  model?: string;
  timeout?: number;
  tags: string[];
  isActive: boolean;
}

export interface RunResponse {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: "running" | "success" | "failed" | "timeout";
  trigger: "scheduled" | "manual";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface LogResponse {
  content: string;
  offset: number;
  done: boolean;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_API_BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as Record<string, string>).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<HealthResponse> {
  return fetchApi("/health");
}

export function getJobs(): Promise<JobResponse[]> {
  return fetchApi("/jobs");
}

export function getRuns(params?: { job?: string; status?: string; limit?: number }): Promise<RunResponse[]> {
  const searchParams = new URLSearchParams();
  if (params?.job) searchParams.set("job", params.job);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  const qs = searchParams.toString();
  return fetchApi(`/runs${qs ? `?${qs}` : ""}`);
}

export function getRunLog(jobId: string, runId: string, offset: number): Promise<LogResponse> {
  return fetchApi(`/runs/${jobId}/${runId}/log?offset=${offset}`);
}

export function triggerJob(jobId: string): Promise<{ runId: string }> {
  return fetchApi(`/runs/${jobId}/trigger`, { method: "POST" });
}
```

- [ ] **Step 5: Create sidebar.tsx**

Create `src/web/components/sidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getHealth, type HealthResponse } from "@/lib/api-client";

const navItems = [
  { href: "/", label: "Dashboard", icon: "grid" },
  { href: "/jobs", label: "Jobs", icon: "list" },
  { href: "/runs", label: "Run History", icon: "clock" },
  { href: "/config", label: "Config", icon: "file" },
];

const icons: Record<string, string> = {
  grid: "M3 3h7v7H3V3zm11 0h7v7h-7V3zm-11 11h7v7H3v-7zm11 0h7v7h-7v-7z",
  list: "M3 4h18M3 8h18M3 12h14M3 16h10",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4v6l4 2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-2 1v5h5",
};

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const fetchHealth = () => {
      getHealth()
        .then(setHealth)
        .catch(() => setHealth(null));
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background px-3 py-4">
      <div className="mb-6 flex items-center gap-2 px-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          AI
        </div>
        <span className="text-sm font-semibold">AI Scheduler</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-secondary text-secondary-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={icons[item.icon]} />
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-2 px-3 py-1">
          <div
            className={`h-2 w-2 rounded-full ${
              health ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]" : "bg-zinc-500"
            }`}
          />
          <span className="text-xs text-muted-foreground">
            {health ? "Daemon running" : "Daemon offline"}
          </span>
        </div>
        {health && (
          <div className="px-3 text-[11px] text-zinc-600">
            PID {health.pid}
          </div>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Create layout.tsx**

Create `src/web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Scheduler",
  description: "Schedule and monitor Claude CLI runs",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="flex h-screen">
          <Sidebar />
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 7: Create placeholder dashboard page**

Create `src/web/app/page.tsx`:

```tsx
export default function DashboardPage(): React.ReactElement {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-sm text-muted-foreground mt-1">Overview of your scheduled AI runs</p>
    </div>
  );
}
```

- [ ] **Step 8: Create Next.js API proxy routes**

Create `src/web/app/api/health/route.ts`:

```typescript
import { NextResponse } from "next/server";
import fs from "fs";
import { getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

async function getDaemonUrl(): Promise<string | null> {
  try {
    const daemonJson = JSON.parse(fs.readFileSync(getDaemonJsonPath(PROJECT_ROOT), "utf-8"));
    return `http://127.0.0.1:${daemonJson.port}`;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  const url = await getDaemonUrl();
  if (!url) {
    return NextResponse.json({ status: "stopped", error: "Daemon not running" }, { status: 503 });
  }
  try {
    const res = await fetch(`${url}/api/health`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "stopped", error: "Daemon not responding" }, { status: 503 });
  }
}
```

Create `src/web/app/api/jobs/route.ts`:

```typescript
import { NextResponse } from "next/server";
import fs from "fs";
import { getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

async function proxyToDaemon(apiPath: string): Promise<NextResponse> {
  try {
    const daemonJson = JSON.parse(fs.readFileSync(getDaemonJsonPath(PROJECT_ROOT), "utf-8"));
    const res = await fetch(`http://127.0.0.1:${daemonJson.port}${apiPath}`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}

export async function GET(): Promise<NextResponse> {
  return proxyToDaemon("/api/jobs");
}
```

Create `src/web/app/api/runs/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import fs from "fs";
import { getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams.toString();
  try {
    const daemonJson = JSON.parse(fs.readFileSync(getDaemonJsonPath(PROJECT_ROOT), "utf-8"));
    const url = `http://127.0.0.1:${daemonJson.port}/api/runs${searchParams ? `?${searchParams}` : ""}`;
    const res = await fetch(url);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
```

Create `src/web/app/api/runs/[jobId]/trigger/route.ts`:

```typescript
import { NextResponse } from "next/server";
import fs from "fs";
import { getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<NextResponse> {
  const { jobId } = await params;
  try {
    const daemonJson = JSON.parse(fs.readFileSync(getDaemonJsonPath(PROJECT_ROOT), "utf-8"));
    const res = await fetch(`http://127.0.0.1:${daemonJson.port}/api/runs/${jobId}/trigger`, {
      method: "POST",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
```

Create `src/web/app/api/runs/[jobId]/[runId]/log/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import fs from "fs";
import { getDaemonJsonPath } from "@shared/paths";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string; runId: string }> }
): Promise<NextResponse> {
  const { jobId, runId } = await params;
  const offset = request.nextUrl.searchParams.get("offset") || "0";
  try {
    const daemonJson = JSON.parse(fs.readFileSync(getDaemonJsonPath(PROJECT_ROOT), "utf-8"));
    const res = await fetch(
      `http://127.0.0.1:${daemonJson.port}/api/runs/${jobId}/${runId}/log?offset=${offset}`
    );
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
```

- [ ] **Step 9: Verify the app builds and starts**

```bash
cd /Users/akorinek/Programming/ai-scheduler
npm run dev
```

Open http://localhost:3500 — should see the sidebar and placeholder dashboard. Stop with Ctrl+C.

- [ ] **Step 10: Commit**

```bash
git add src/web/ next.config.ts postcss.config.mjs
git commit -m "feat: add Next.js app shell with shadcn/ui, sidebar, and API proxy routes"
```

---

### Task 9: Dashboard Page (stats + recent runs + job cards)

**Files:**
- Create: `src/web/components/stats-cards.tsx`
- Create: `src/web/components/runs-table.tsx`
- Create: `src/web/components/job-card.tsx`
- Modify: `src/web/app/page.tsx`

- [ ] **Step 1: Create stats-cards.tsx**

Create `src/web/components/stats-cards.tsx`:

```tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunResponse, JobResponse, HealthResponse } from "@/lib/api-client";

interface StatsCardsProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  health: HealthResponse | null;
}

function getNextRun(jobs: JobResponse[]): { jobName: string; time: string } | null {
  // Simple heuristic — show next enabled job. Full cron calculation would need a library.
  const enabledJobs = jobs.filter((j) => j.enabled);
  if (enabledJobs.length === 0) return null;
  return { jobName: enabledJobs[0].name, time: enabledJobs[0].schedule };
}

export function StatsCards({ jobs, runs, health }: StatsCardsProps): React.ReactElement {
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const todayRuns = runs.filter((r) => {
    const runDate = new Date(r.startedAt).toDateString();
    return runDate === new Date().toDateString();
  });
  const successCount = todayRuns.filter((r) => r.status === "success").length;
  const failedCount = todayRuns.filter((r) => r.status === "failed").length;
  const runningCount = todayRuns.filter((r) => r.status === "running").length;
  const activeRun = runs.find((r) => r.status === "running");

  return (
    <div className="grid grid-cols-4 gap-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Total Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{jobs.length}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {enabledCount} enabled · {jobs.length - enabledCount} disabled
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Runs Today</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{todayRuns.length}</div>
          <p className="text-xs mt-1">
            <span className="text-green-500">{successCount} passed</span>
            {failedCount > 0 && <> · <span className="text-red-500">{failedCount} failed</span></>}
            {runningCount > 0 && <> · <span className="text-yellow-500">{runningCount} running</span></>}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Active Run</CardTitle>
        </CardHeader>
        <CardContent>
          {activeRun ? (
            <>
              <div className="text-xl font-semibold text-yellow-500">{activeRun.jobName}</div>
              <p className="text-xs text-muted-foreground mt-1">Running...</p>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-muted-foreground">None</div>
              <p className="text-xs text-muted-foreground mt-1">All idle</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Daemon</CardTitle>
        </CardHeader>
        <CardContent>
          {health ? (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
                <span className="text-xl font-semibold">Online</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">PID {health.pid}</p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-zinc-500" />
                <span className="text-xl font-semibold text-muted-foreground">Offline</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Daemon not running</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create runs-table.tsx**

Create `src/web/components/runs-table.tsx`:

```tsx
"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import type { RunResponse } from "@/lib/api-client";
import path from "path";

interface RunsTableProps {
  runs: RunResponse[];
  limit?: number;
}

function StatusBadge({ status }: { status: RunResponse["status"] }): React.ReactElement {
  const variants: Record<string, { className: string; label: string }> = {
    running: { className: "border-yellow-500/50 text-yellow-500", label: "running" },
    success: { className: "border-green-500/50 text-green-500", label: "success" },
    failed: { className: "border-red-500/50 text-red-500", label: "failed" },
    timeout: { className: "border-orange-500/50 text-orange-500", label: "timeout" },
  };
  const v = variants[status] ?? variants.failed;

  return (
    <Badge variant="outline" className={v.className}>
      {status === "running" && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />
      )}
      {status === "success" && <span className="mr-1">✓</span>}
      {status === "failed" && <span className="mr-1">✗</span>}
      {status === "timeout" && <span className="mr-1">⏱</span>}
      {v.label}
    </Badge>
  );
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function RunsTable({ runs, limit }: RunsTableProps): React.ReactElement {
  const displayRuns = limit ? runs.slice(0, limit) : runs;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Status</TableHead>
          <TableHead>Job</TableHead>
          <TableHead>Directory</TableHead>
          <TableHead className="w-[70px]">Trigger</TableHead>
          <TableHead className="w-[120px]">Started</TableHead>
          <TableHead className="w-[80px]">Duration</TableHead>
          <TableHead className="w-[60px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {displayRuns.map((run) => (
          <TableRow key={`${run.jobId}-${run.runId}`}>
            <TableCell>
              <StatusBadge status={run.status} />
            </TableCell>
            <TableCell className="font-medium">{run.jobName}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {run.directory.split("/").pop()}
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="text-muted-foreground">
                {run.trigger}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {formatTime(run.startedAt)}
            </TableCell>
            <TableCell className="font-mono text-sm text-muted-foreground">
              {formatDuration(run.startedAt, run.finishedAt)}
            </TableCell>
            <TableCell>
              <Link href={`/runs/${run.jobId}/${run.runId}`}>
                <Button variant="outline" size="sm" className="text-xs">
                  {run.status === "running" ? "Watch" : "Logs"}
                </Button>
              </Link>
            </TableCell>
          </TableRow>
        ))}
        {displayRuns.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
              No runs yet
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Create job-card.tsx**

Create `src/web/components/job-card.tsx`:

```tsx
"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { JobResponse, RunResponse } from "@/lib/api-client";
import { triggerJob } from "@/lib/api-client";
import { useState } from "react";

interface JobCardProps {
  job: JobResponse;
  lastRun?: RunResponse;
  onTrigger: () => void;
}

function formatCronHuman(cron: string): string {
  // Basic human-readable cron. Handles common patterns.
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, _dom, _mon, dow] = parts;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

  if (dow === "*") return `Daily at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (dow === "1") return `Mondays at ${time}`;
  if (dow === "3") return `Wednesdays at ${time}`;
  return `${time} (${cron})`;
}

export function JobCard({ job, lastRun, onTrigger }: JobCardProps): React.ReactElement {
  const [isTriggering, setIsTriggering] = useState(false);

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      await triggerJob(job.id);
      onTrigger();
    } catch (err) {
      console.error("Failed to trigger job:", err);
    } finally {
      setIsTriggering(false);
    }
  };

  const lastRunStatus = lastRun?.status;
  const statusColor = lastRunStatus === "success"
    ? "bg-green-500"
    : lastRunStatus === "failed"
      ? "bg-red-500"
      : lastRunStatus === "running"
        ? "bg-yellow-500"
        : "bg-zinc-500";

  return (
    <Card className={!job.enabled ? "opacity-50" : ""}>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold">{job.name}</span>
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
        </div>
        <div className="text-xs text-muted-foreground font-mono mb-1">
          {job.directory.split("/").pop()}
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          {formatCronHuman(job.schedule)}
          {!job.enabled && " · disabled"}
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            className="text-xs"
            onClick={handleTrigger}
            disabled={isTriggering || job.isActive}
          >
            {isTriggering ? "Starting..." : "Run now"}
          </Button>
          {lastRun && (
            <span className="ml-auto text-[11px] text-zinc-500">
              Last: {lastRunStatus === "success" ? "✓" : lastRunStatus === "failed" ? "✗" : "..."}{" "}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Update dashboard page**

Replace `src/web/app/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatsCards } from "@/components/stats-cards";
import { RunsTable } from "@/components/runs-table";
import { JobCard } from "@/components/job-card";
import {
  getHealth,
  getJobs,
  getRuns,
  type HealthResponse,
  type JobResponse,
  type RunResponse,
} from "@/lib/api-client";

export default function DashboardPage(): React.ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);

  const fetchAll = useCallback(async () => {
    try {
      const [h, j, r] = await Promise.all([
        getHealth().catch(() => null),
        getJobs().catch(() => []),
        getRuns({ limit: 20 }).catch(() => []),
      ]);
      setHealth(h);
      setJobs(j);
      setRuns(r);
    } catch {
      // silently fail — UI shows "offline" state
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const getLastRun = (jobId: string): RunResponse | undefined => {
    return runs.find((r) => r.jobId === jobId);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your scheduled AI runs
        </p>
      </div>

      <StatsCards jobs={jobs} runs={runs} health={health} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          <RunsTable runs={runs} limit={10} />
        </CardContent>
      </Card>

      <div>
        <h2 className="text-sm font-semibold mb-3">Jobs</h2>
        <div className="grid grid-cols-3 gap-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              lastRun={getLastRun(job.id)}
              onTrigger={fetchAll}
            />
          ))}
          {jobs.length === 0 && (
            <p className="text-sm text-muted-foreground col-span-3 text-center py-8">
              No jobs configured. Add jobs to scheduler.yaml.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify dashboard renders**

```bash
npm run dev
```

Open http://localhost:3500 — should see the full dashboard layout (data will be empty if daemon isn't running). Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/stats-cards.tsx src/web/components/runs-table.tsx src/web/components/job-card.tsx src/web/app/page.tsx
git commit -m "feat: add dashboard with stats cards, runs table, and job cards"
```

---

### Task 10: Log Viewer Page

**Files:**
- Create: `src/web/components/log-viewer.tsx`
- Create: `src/web/app/runs/[jobId]/[runId]/page.tsx`

- [ ] **Step 1: Create log-viewer.tsx**

Create `src/web/components/log-viewer.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { getRunLog, type LogResponse } from "@/lib/api-client";

interface LogViewerProps {
  jobId: string;
  runId: string;
}

export function LogViewer({ jobId, runId }: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [isDone, setIsDone] = useState(false);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const data: LogResponse = await getRunLog(jobId, runId, offset);
        if (!active) return;

        if (data.content) {
          setLines((prev) => prev + data.content);
          setOffset(data.offset);
        }
        if (data.done) {
          setIsDone(true);
        }
      } catch {
        // retry on next interval
      }
    };

    poll();
    const interval = isDone ? null : setInterval(poll, 3_000);

    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [jobId, runId, offset, isDone]);

  useEffect(() => {
    if (isAutoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, isAutoScroll]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setIsAutoScroll(isAtBottom);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {!isDone && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
          )}
          <span className="text-xs text-muted-foreground">
            {isDone ? "Run completed" : "Live output — polling every 3s"}
          </span>
        </div>
        {!isDone && (
          <button
            onClick={() => setIsAutoScroll(!isAutoScroll)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {isAutoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto rounded-md border border-border bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300"
        style={{ minHeight: 400, maxHeight: "calc(100vh - 280px)" }}
      >
        <pre className="whitespace-pre-wrap">{lines || "Waiting for output..."}</pre>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create run detail page**

Create `src/web/app/runs/[jobId]/[runId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogViewer } from "@/components/log-viewer";
import { getRuns, type RunResponse } from "@/lib/api-client";

export default function RunDetailPage(): React.ReactElement {
  const params = useParams<{ jobId: string; runId: string }>();
  const router = useRouter();
  const [run, setRun] = useState<RunResponse | null>(null);

  useEffect(() => {
    getRuns({ job: params.jobId })
      .then((runs) => {
        const found = runs.find((r) => r.runId === params.runId);
        if (found) setRun(found);
      })
      .catch(() => {});
  }, [params.jobId, params.runId]);

  const statusColors: Record<string, string> = {
    running: "border-yellow-500/50 text-yellow-500",
    success: "border-green-500/50 text-green-500",
    failed: "border-red-500/50 text-red-500",
    timeout: "border-orange-500/50 text-orange-500",
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          ← Back
        </Button>
        <div>
          <h1 className="text-lg font-semibold">
            {run?.jobName ?? params.jobId}
          </h1>
          <p className="text-xs text-muted-foreground font-mono">{params.runId}</p>
        </div>
        {run && (
          <Badge variant="outline" className={statusColors[run.status] ?? ""}>
            {run.status}
          </Badge>
        )}
        {run?.finishedAt && (
          <span className="text-xs text-muted-foreground ml-auto">
            Exit code: {run.exitCode}
          </span>
        )}
      </div>

      <LogViewer jobId={params.jobId} runId={params.runId} />
    </div>
  );
}
```

- [ ] **Step 3: Verify log viewer renders**

```bash
npm run dev
```

Navigate to http://localhost:3500/runs/test-job/test-run — should see the log viewer shell (empty if no data). Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/log-viewer.tsx src/web/app/runs/
git commit -m "feat: add log viewer with live polling and auto-scroll"
```

---

### Task 11: Jobs Page + Run History Page + Config Page

**Files:**
- Create: `src/web/app/jobs/page.tsx`
- Create: `src/web/app/runs/page.tsx`
- Create: `src/web/app/config/page.tsx`

- [ ] **Step 1: Create jobs page**

Create `src/web/app/jobs/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getJobs, getRuns, triggerJob, type JobResponse, type RunResponse } from "@/lib/api-client";

export default function JobsPage(): React.ReactElement {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [j, r] = await Promise.all([
      getJobs().catch(() => []),
      getRuns({ limit: 100 }).catch(() => []),
    ]);
    setJobs(j);
    setRuns(r);
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const allTags = [...new Set(jobs.flatMap((j) => j.tags))].sort();
  const filteredJobs = tagFilter ? jobs.filter((j) => j.tags.includes(tagFilter)) : jobs;

  const handleTrigger = async (jobId: string) => {
    setTriggeringId(jobId);
    try {
      await triggerJob(jobId);
      fetchAll();
    } catch (err) {
      console.error("Trigger failed:", err);
    } finally {
      setTriggeringId(null);
    }
  };

  const getLastRun = (jobId: string): RunResponse | undefined =>
    runs.find((r) => r.jobId === jobId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground mt-1">All configured scheduled jobs</p>
      </div>

      {allTags.length > 0 && (
        <div className="flex gap-2">
          <Button
            variant={tagFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTagFilter(null)}
          >
            All
          </Button>
          {allTags.map((tag) => (
            <Button
              key={tag}
              variant={tagFilter === tag ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTagFilter(tag)}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filteredJobs.map((job) => {
          const lastRun = getLastRun(job.id);
          return (
            <Card key={job.id} className={!job.enabled ? "opacity-50" : ""}>
              <CardContent className="flex items-center gap-4 py-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{job.name}</span>
                    {!job.enabled && (
                      <Badge variant="outline" className="text-zinc-500">disabled</Badge>
                    )}
                    {job.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    <span className="font-mono">{job.directory}</span>
                    <span className="mx-2">·</span>
                    <span>{job.schedule}</span>
                    {job.model && <><span className="mx-2">·</span><span>model: {job.model}</span></>}
                  </div>
                  <div className="text-xs text-zinc-600 mt-1 max-w-xl truncate">{job.prompt}</div>
                </div>
                <div className="flex items-center gap-3">
                  {lastRun && (
                    <span className="text-xs text-muted-foreground">
                      Last: {lastRun.status === "success" ? "✓" : lastRun.status === "failed" ? "✗" : "..."}
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => handleTrigger(job.id)}
                    disabled={triggeringId === job.id || job.isActive}
                  >
                    {triggeringId === job.id ? "Starting..." : "Run now"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {filteredJobs.length === 0 && (
          <p className="text-center text-muted-foreground py-8">
            {jobs.length === 0 ? "No jobs configured" : "No jobs match filter"}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create run history page**

Create `src/web/app/runs/page.tsx`:

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RunsTable } from "@/components/runs-table";
import { getRuns, getJobs, type RunResponse, type JobResponse } from "@/lib/api-client";

export default function RunHistoryPage(): React.ReactElement {
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [r, j] = await Promise.all([
      getRuns({
        limit: 100,
        ...(jobFilter ? { job: jobFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }).catch(() => []),
      getJobs().catch(() => []),
    ]);
    setRuns(r);
    setJobs(j);
  }, [jobFilter, statusFilter]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Run History</h1>
        <p className="text-sm text-muted-foreground mt-1">All runs across all jobs</p>
      </div>

      <div className="flex gap-4">
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground">Job:</span>
          <Button
            variant={jobFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setJobFilter(null)}
          >
            All
          </Button>
          {jobs.map((job) => (
            <Button
              key={job.id}
              variant={jobFilter === job.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setJobFilter(job.id)}
            >
              {job.name}
            </Button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground">Status:</span>
          {["success", "failed", "running", "timeout"].map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <RunsTable runs={runs} />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create config page**

Create `src/web/app/config/page.tsx`:

```tsx
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "scheduler.yaml");

export default function ConfigPage(): React.ReactElement {
  let content = "";
  let lastModified = "";

  try {
    content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const stat = fs.statSync(CONFIG_PATH);
    lastModified = stat.mtime.toLocaleString();
  } catch {
    content = "# Config file not found";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Config</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only view of scheduler.yaml · Last modified: {lastModified}
        </p>
      </div>

      <div className="rounded-md border border-border bg-zinc-950 p-6">
        <pre className="font-mono text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
          {content}
        </pre>
      </div>

      <p className="text-xs text-muted-foreground">
        To edit, use the <code className="bg-zinc-800 px-1 py-0.5 rounded">/ai-scheduler</code> skill in Claude Code.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Verify all pages render**

```bash
npm run dev
```

Check: http://localhost:3500/jobs, http://localhost:3500/runs, http://localhost:3500/config. Stop with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add src/web/app/jobs/ src/web/app/runs/page.tsx src/web/app/config/
git commit -m "feat: add jobs, run history, and config pages"
```

---

### Task 12: Claude Code Skill

**Files:**
- Create: `skill/ai-scheduler.md`

- [ ] **Step 1: Create the skill file**

Create `skill/ai-scheduler.md`:

````markdown
---
name: ai-scheduler
description: Manage AI Scheduler — add, remove, enable/disable scheduled Claude runs, control the daemon, and open the web UI
---

You are managing the AI Scheduler, a tool that runs Claude on a cron schedule across multiple project directories.

**Config file location:** Find `scheduler.yaml` by searching upward from the current directory, or check common locations:
- `/Users/akorinek/Programming/ai-scheduler/scheduler.yaml`

**Project root:** The directory containing `scheduler.yaml`.

## Commands

Parse the user's intent and execute one of these actions:

### Add a job
Read the current `scheduler.yaml`, add a new job entry under `jobs:`, and write it back. Generate a slug-style job ID from the name (e.g., "Review PRs" → `review-prs`).

Required info (ask if not provided):
- **name**: human-readable name
- **schedule**: cron expression (help the user write it if they describe it in natural language like "every weekday at 9am" → `0 9 * * 1-5`)
- **directory**: absolute path to the working directory
- **prompt**: the instruction for Claude

Optional: `model`, `timeout`, `tags`, `enabled`

### List jobs
Read `scheduler.yaml` and display all jobs in a readable format.

### Enable / Disable a job
Read `scheduler.yaml`, set `enabled: true` or `enabled: false` on the specified job, write it back.

### Remove a job
Read `scheduler.yaml`, remove the job entry, write it back. Confirm with the user before removing.

### Status
Check if the daemon is running by reading `data/daemon.json` in the project root. Show:
- Daemon status (running/stopped), PID, uptime
- Number of registered jobs
- Currently active runs

### Start daemon
```bash
/path/to/ai-scheduler/scripts/start-daemon.sh
```

### Stop daemon
```bash
/path/to/ai-scheduler/scripts/stop-daemon.sh
```

### Open UI
```bash
open http://localhost:3500
```

## Rules
- Always read the current `scheduler.yaml` before modifying it
- Use `js-yaml`-compatible YAML formatting when writing back
- Preserve comments and formatting where possible
- After modifying config, confirm what changed — the daemon picks it up automatically via file watch
````

- [ ] **Step 2: Commit**

```bash
git add skill/
git commit -m "feat: add Claude Code skill for managing scheduler via conversation"
```

---

### Task 13: Run Pruning

**Files:**
- Create: `src/daemon/pruner.ts`
- Create: `src/daemon/__tests__/pruner.test.ts`

- [ ] **Step 1: Write failing tests for pruner**

Create `src/daemon/__tests__/pruner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pruneOldRuns } from "../pruner";
import fs from "fs";
import path from "path";
import os from "os";

describe("pruneOldRuns", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-prune-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes oldest runs when count exceeds limit", () => {
    const jobDir = path.join(tmpDir, "data", "runs", "test-job");
    // Create 5 run dirs with sequential names
    for (let i = 1; i <= 5; i++) {
      const runDir = path.join(jobDir, `2026-04-0${i}T09-00-00-abc${i}23`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "meta.json"), "{}");
      fs.writeFileSync(path.join(runDir, "status.json"), "{}");
      fs.writeFileSync(path.join(runDir, "output.log"), "log");
    }

    pruneOldRuns(tmpDir, "test-job", 3);

    const remaining = fs.readdirSync(jobDir).filter((d) => d !== "latest");
    expect(remaining).toHaveLength(3);
    // Should keep the 3 newest (03, 04, 05)
    expect(remaining.sort()).toEqual([
      "2026-04-03T09-00-00-abc323",
      "2026-04-04T09-00-00-abc423",
      "2026-04-05T09-00-00-abc523",
    ]);
  });

  it("does nothing when count is under limit", () => {
    const jobDir = path.join(tmpDir, "data", "runs", "test-job");
    const runDir = path.join(jobDir, "2026-04-01T09-00-00-abc123");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "meta.json"), "{}");

    pruneOldRuns(tmpDir, "test-job", 5);

    const remaining = fs.readdirSync(jobDir).filter((d) => d !== "latest");
    expect(remaining).toHaveLength(1);
  });

  it("does nothing when job dir does not exist", () => {
    // Should not throw
    pruneOldRuns(tmpDir, "nonexistent-job", 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/daemon/__tests__/pruner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pruner.ts**

Create `src/daemon/pruner.ts`:

```typescript
import fs from "fs";
import path from "path";
import { getJobDir } from "@shared/paths";

export function pruneOldRuns(projectRoot: string, jobId: string, retainCount: number): void {
  const jobDir = getJobDir(projectRoot, jobId);

  if (!fs.existsSync(jobDir)) return;

  const entries = fs.readdirSync(jobDir).filter((d) => {
    if (d === "latest") return false;
    return fs.statSync(path.join(jobDir, d)).isDirectory();
  });

  if (entries.length <= retainCount) return;

  // Sort ascending (oldest first) — run IDs are ISO timestamps, so lexicographic sort works
  entries.sort();

  const toRemove = entries.slice(0, entries.length - retainCount);
  for (const runId of toRemove) {
    fs.rmSync(path.join(jobDir, runId), { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/daemon/__tests__/pruner.test.ts
```

Expected: PASS

- [ ] **Step 5: Integrate pruner into cron-engine**

Add pruning after job completion in `src/daemon/cron-engine.ts`. In the `executeJob` method, after the `runJob` call succeeds, add:

```typescript
import { pruneOldRuns } from "./pruner";
```

In `executeJob`, after the `console.log` for completion:

```typescript
pruneOldRuns(this.projectRoot, jobId, config.defaults.retain_runs);
```

Also add pruning after `triggerJob` completes, before the `finally` block:

```typescript
if (this.currentConfig) {
  pruneOldRuns(this.projectRoot, jobId, this.currentConfig.defaults.retain_runs);
}
```

- [ ] **Step 6: Run all daemon tests**

```bash
npx vitest run src/daemon/
```

Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add src/daemon/pruner.ts src/daemon/__tests__/pruner.test.ts src/daemon/cron-engine.ts
git commit -m "feat: add run pruning to clean up old runs per retain_runs config"
```

---

### Task 14: End-to-End Smoke Test

**Files:**
- Create: `src/__tests__/e2e-smoke.test.ts`

- [ ] **Step 1: Write smoke test**

Create `src/__tests__/e2e-smoke.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";

describe("E2E smoke test", () => {
  let tmpDir: string;
  let daemon: ChildProcess;
  let daemonPort: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-e2e-"));
    fs.mkdirSync(path.join(tmpDir, "data", "runs"), { recursive: true });

    // Write a test config with a job that runs `echo`
    const config = {
      version: 1,
      defaults: { timeout: 30, max_retries: 0, retain_runs: 10 },
      jobs: {
        "echo-test": {
          name: "Echo Test",
          schedule: "0 0 31 2 *", // Feb 31 — never fires naturally
          directory: os.tmpdir(),
          prompt: "test",
          enabled: true,
          tags: ["test"],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "scheduler.yaml"), yaml.dump(config));

    // Start daemon pointing to tmp project root
    daemon = spawn("npx", ["tsx", path.resolve("src/daemon/index.ts")], {
      cwd: tmpDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for daemon to be ready
    daemonPort = 3501;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${daemonPort}/api/health`);
        if (res.ok) break;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 30000);

  afterAll(() => {
    if (daemon) daemon.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("daemon health endpoint responds", async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/health`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe("running");
  });

  it("lists jobs from config", async () => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/jobs`);
    const jobs = await res.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("echo-test");
  });

  it("manually triggers a job and creates run data", async () => {
    const triggerRes = await fetch(`http://127.0.0.1:${daemonPort}/api/runs/echo-test/trigger`, {
      method: "POST",
    });
    expect(triggerRes.ok).toBe(true);
    const { runId } = await triggerRes.json();
    expect(runId).toBeTruthy();

    // Wait for run to complete
    await new Promise((r) => setTimeout(r, 3000));

    const runsRes = await fetch(`http://127.0.0.1:${daemonPort}/api/runs`);
    const runs = await runsRes.json();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].jobId).toBe("echo-test");
  }, 15000);
});
```

- [ ] **Step 2: Run smoke test**

```bash
npx vitest run src/__tests__/e2e-smoke.test.ts
```

Expected: PASS (daemon starts, health works, trigger creates a run)

Note: This test spawns the daemon as a subprocess. If the `claude` CLI isn't available, the trigger test will show a "failed" run (process error), which is expected for CI. The important thing is the plumbing works.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/e2e-smoke.test.ts
git commit -m "test: add end-to-end smoke test for daemon API"
```

---

### Task 15: Final Wiring and Verification

- [ ] **Step 1: Verify all tests pass**

```bash
npx vitest run
```

Expected: All unit tests and integration tests pass.

- [ ] **Step 2: Start daemon and verify with real config**

Edit `scheduler.yaml` to add a test job:

```yaml
version: 1

defaults:
  timeout: 300
  max_retries: 0
  retain_runs: 50

jobs:
  hello-test:
    name: "Hello Test"
    schedule: "0 0 31 2 *"
    directory: /tmp
    prompt: "Say hello"
    enabled: true
    tags: [test]
```

Start the daemon and web UI:

```bash
./scripts/start-daemon.sh
npm run dev
```

- [ ] **Step 3: Verify dashboard in browser**

Open http://localhost:3500. Verify:
- Sidebar shows "Daemon running"
- Dashboard shows 1 job
- Job card shows "Hello Test"
- Click "Run now" — a run should appear in the recent runs table
- Click "Watch" or "Logs" — log viewer should show output

- [ ] **Step 4: Stop daemon**

```bash
./scripts/stop-daemon.sh
```

- [ ] **Step 5: Install the skill**

```bash
cp skill/ai-scheduler.md ~/.claude/skills/ai-scheduler.md
```

- [ ] **Step 6: Final commit**

```bash
git add scheduler.yaml
git commit -m "chore: add example job config and complete initial setup"
```
