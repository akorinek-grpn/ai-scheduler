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
      expect(result.data.defaults.priority).toBe("background");
      expect(result.data.jobs["my-job"].enabled).toBe(true);
      expect(result.data.jobs["my-job"].priority).toBeUndefined();
    }
  });

  it("accepts a per-job priority override and rejects unknown values", () => {
    const base = {
      version: 1,
      jobs: {
        "my-job": {
          name: "My Job",
          schedule: "0 9 * * *",
          directory: "/tmp/test",
          prompt: "Do something",
          priority: "normal",
        },
      },
    };
    const ok = configSchema.safeParse(base);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.jobs["my-job"].priority).toBe("normal");

    const bad = configSchema.safeParse({
      ...base,
      jobs: { "my-job": { ...base.jobs["my-job"], priority: "low" } },
    });
    expect(bad.success).toBe(false);
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

  it("accepts a per-job catchup policy and leaves it unset by default", () => {
    const job = (extra: Record<string, unknown>) => ({
      version: 1,
      jobs: {
        j: {
          name: "J",
          schedule: "0 17 * * 0-4",
          directory: "/tmp",
          prompt: "p",
          ...extra,
        },
      },
    });
    for (const policy of ["always", "same-day", "never"]) {
      const result = configSchema.safeParse(job({ catchup: policy }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.jobs.j.catchup).toBe(policy);
    }
    const unset = configSchema.safeParse(job({}));
    expect(unset.success).toBe(true);
    if (unset.success) expect(unset.data.jobs.j.catchup).toBeUndefined();
  });

  it("rejects an unknown catchup policy", () => {
    const input = {
      version: 1,
      jobs: {
        j: {
          name: "J",
          schedule: "0 17 * * 0-4",
          directory: "/tmp",
          prompt: "p",
          catchup: "next-day",
        },
      },
    };
    expect(configSchema.safeParse(input).success).toBe(false);
  });

  it("accepts empty jobs object", () => {
    const input = { version: 1, jobs: {} };
    const result = configSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  describe("precondition and outcome codes (2026-10-16)", () => {
    const job = (extra: Record<string, unknown>) => ({
      version: 1,
      jobs: { j: { name: "J", schedule: "0 * * * *", directory: "/tmp", prompt: "p", ...extra } },
    });

    it("accepts a precondition with its timeout, retry delay and blocked exit codes", () => {
      const result = configSchema.safeParse(
        job({
          precondition: "bash scripts/precondition-autopilot-lock.sh",
          precondition_timeout: 30,
          retry_after: 300,
          outcome_codes: { blocked: [30] },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success)
        expect(result.data.jobs.j).toMatchObject({
          precondition: "bash scripts/precondition-autopilot-lock.sh",
          precondition_timeout: 30,
          retry_after: 300,
          outcome_codes: { blocked: [30] },
        });
    });

    it("leaves them unset by default", () => {
      const result = configSchema.safeParse(job({}));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jobs.j.precondition).toBeUndefined();
        expect(result.data.jobs.j.outcome_codes).toBeUndefined();
      }
    });

    it("rejects an empty precondition, a non-positive delay and an exit code outside 1-255", () => {
      expect(configSchema.safeParse(job({ precondition: "" })).success).toBe(false);
      expect(configSchema.safeParse(job({ retry_after: 0 })).success).toBe(false);
      expect(configSchema.safeParse(job({ precondition_timeout: -1 })).success).toBe(false);
      expect(configSchema.safeParse(job({ outcome_codes: { blocked: [0] } })).success).toBe(false);
      expect(configSchema.safeParse(job({ outcome_codes: { blocked: [256] } })).success).toBe(false);
      expect(configSchema.safeParse(job({ outcome_codes: { blocked: ["30"] } })).success).toBe(false);
    });
  });
});
