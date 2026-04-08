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
