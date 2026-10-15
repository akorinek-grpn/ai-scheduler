import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import type { DaemonHealthSnapshot, HostStatus } from "../hosts";

async function get(app: ReturnType<typeof createApp>, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${port}${url}`)
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

const job = (runsOn: string) => `
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
    runs_on: ${runsOn}
`;

const twoHosts = `version: 1
hosts:
  LAPTOP-1: groupon-mac-16
  AIR-1: { role: groupon-mac-air, ssh: air }
  SHELF-1: { role: shelf, ssh: shelf }
  NAS-1: nas
jobs:
  summaries:
    name: Summaries${job("groupon-mac-16")}
  reviews:
    name: Reviews${job("groupon-mac-air")}
  janitor:
    name: Janitor${job("all")}
`;

describe("GET /api/hosts", () => {
  let tmpDir: string;
  let engine: CronEngine;
  let savedHost: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-hosts-"));
    fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
    engine = new CronEngine(tmpDir);
    savedHost = process.env.AI_SCHEDULER_HOST;
    process.env.AI_SCHEDULER_HOST = "laptop-1";
  });

  afterEach(() => {
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedHost === undefined) delete process.env.AI_SCHEDULER_HOST;
    else process.env.AI_SCHEDULER_HOST = savedHost;
  });

  it("lists every host with its placed jobs and probed health", async () => {
    fs.writeFileSync(path.join(tmpDir, "scheduler.yaml"), twoHosts);
    const airHealth: DaemonHealthSnapshot = {
      status: "running",
      pid: 4242,
      startedAt: "2026-10-15T09:00:00.000Z",
      activeJobs: ["reviews"],
      host: { name: "AIR-1", role: "groupon-mac-air" },
    };
    const probed: string[] = [];
    const app = createApp(engine, tmpDir, new Date().toISOString(), {
      probeHost: async (ssh) => {
        probed.push(ssh);
        if (ssh === "air") return airHealth;
        throw new Error("ssh: connect to host shelf port 22: Operation timed out");
      },
    });

    const res = await get(app, "/api/hosts");
    expect(res.status).toBe(200);
    const body = res.body as { self: { name: string; role: string }; hosts: HostStatus[] };
    expect(body.self).toEqual({ name: "laptop-1", role: "groupon-mac-16" });
    expect(probed.sort()).toEqual(["air", "shelf"]);

    const byName = Object.fromEntries(body.hosts.map((h) => [h.name, h]));
    expect(Object.keys(byName).sort()).toEqual(["AIR-1", "LAPTOP-1", "NAS-1", "SHELF-1"]);

    // This process answers for the host we are; its jobs are the role's plus the `all` ones.
    expect(byName["LAPTOP-1"].isSelf).toBe(true);
    expect(byName["LAPTOP-1"].health?.pid).toBe(process.pid);
    expect(byName["LAPTOP-1"].jobs.map((j) => j.id).sort()).toEqual(["janitor", "summaries"]);

    expect(byName["AIR-1"].isSelf).toBe(false);
    expect(byName["AIR-1"].health).toEqual(airHealth);
    expect(byName["AIR-1"].error).toBeNull();
    expect(byName["AIR-1"].jobs.map((j) => j.id).sort()).toEqual(["janitor", "reviews"]);

    // A failed probe is reported, not thrown, and does not hide the other hosts.
    expect(byName["SHELF-1"].health).toBeNull();
    expect(byName["SHELF-1"].error).toMatch(/timed out/);

    // No ssh alias: nothing to probe, and the page says so.
    expect(byName["NAS-1"].health).toBeNull();
    expect(byName["NAS-1"].error).toMatch(/no ssh alias/);
    expect(byName["NAS-1"].jobs.map((j) => j.id)).toEqual(["janitor"]);
  });

  it("answers with no hosts for a single-machine config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "scheduler.yaml"),
      `version: 1
jobs:
  only:
    name: Only
    schedule: "0 9 * * *"
    directory: /tmp
    prompt: go
`,
    );
    const app = createApp(engine, tmpDir, new Date().toISOString(), {
      probeHost: async () => { throw new Error("must not be called"); },
    });
    const res = await get(app, "/api/hosts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ self: null, hosts: [] });
  });
});
