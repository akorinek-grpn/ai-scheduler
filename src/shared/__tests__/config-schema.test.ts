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
