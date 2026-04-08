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
