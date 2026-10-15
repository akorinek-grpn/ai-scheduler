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

  describe("hosts and runs_on (one file for several Macs)", () => {
    const job = (extra: string) => `
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
${extra}`;
    const twoHosts = `version: 1
hosts:
  LAPTOP-1: groupon-mac-16
  AIR-1: groupon-mac-air
jobs:
  reviews:
    name: Reviews${job("    runs_on: groupon-mac-air")}
  summaries:
    name: Summaries${job("    runs_on: [groupon-mac-16]")}
  janitor:
    name: Janitor${job("    runs_on: all")}
`;

    it("keeps only the jobs whose runs_on names this host's role", () => {
      fs.writeFileSync(configPath, twoHosts);
      const air = loadConfig(configPath, { hostName: "AIR-1" });
      expect(air.success).toBe(true);
      if (air.success) {
        expect(Object.keys(air.data.jobs).sort()).toEqual(["janitor", "reviews"]);
        expect(air.data.host).toEqual({ name: "AIR-1", role: "groupon-mac-air" });
      }
      // os.hostname() casing differs from the YAML on macOS; matching ignores case.
      const laptop = loadConfig(configPath, { hostName: "laptop-1" });
      expect(laptop.success).toBe(true);
      if (laptop.success) {
        expect(Object.keys(laptop.data.jobs).sort()).toEqual(["janitor", "summaries"]);
        expect(laptop.data.host?.role).toBe("groupon-mac-16");
      }
    });

    it("resolves the host from AI_SCHEDULER_HOST when no host name is given", () => {
      fs.writeFileSync(configPath, twoHosts);
      const before = process.env.AI_SCHEDULER_HOST;
      process.env.AI_SCHEDULER_HOST = "AIR-1.local";
      try {
        const result = loadConfig(configPath);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.host?.role).toBe("groupon-mac-air");
      } finally {
        if (before === undefined) delete process.env.AI_SCHEDULER_HOST;
        else process.env.AI_SCHEDULER_HOST = before;
      }
    });

    it("refuses a host that hosts does not declare, instead of running everything", () => {
      fs.writeFileSync(configPath, twoHosts);
      const result = loadConfig(configPath, { hostName: "STRAY-MAC" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/STRAY-MAC.*not in 'hosts'/);
    });

    it("requires runs_on on every job once hosts is declared", () => {
      fs.writeFileSync(
        configPath,
        twoHosts + `  orphan:
    name: Orphan${job("")}
`,
      );
      const result = loadConfig(configPath, { hostName: "AIR-1" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/jobs\.orphan\.runs_on: required/);
    });

    it("rejects a runs_on role that hosts does not declare", () => {
      fs.writeFileSync(
        configPath,
        twoHosts + `  typo:
    name: Typo${job("    runs_on: groupon-mac-ari")}
`,
      );
      const result = loadConfig(configPath, { hostName: "AIR-1" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/unknown role "groupon-mac-ari"/);
    });

    it("ignores runs_on and loads every job when hosts is not declared", () => {
      fs.writeFileSync(
        configPath,
        `version: 1
jobs:
  reviews:
    name: Reviews${job("    runs_on: groupon-mac-air")}
  plain:
    name: Plain${job("")}
`,
      );
      const result = loadConfig(configPath, { hostName: "ANY" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data.jobs).sort()).toEqual(["plain", "reviews"]);
        expect(result.data.host).toBeUndefined();
      }
    });
  });
});
