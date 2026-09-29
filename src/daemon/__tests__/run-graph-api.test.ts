import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createApp } from "../api";
import { CronEngine } from "../cron-engine";
import type { JobConfig, RunMeta, RunStatusFile } from "@shared/types";
import type { RunGraph } from "@shared/run-graph-types";

// Like api.test.ts's request(), but over node:http so the path is sent as-is
// (fetch would normalize "/../" segments away before they reach the router).
async function request(
  app: ReturnType<typeof createApp>,
  url: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      http
        .get({ host: "127.0.0.1", port, path: url }, (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (raw += chunk));
          res.on("end", () => {
            server.close();
            let body: unknown = raw;
            try {
              body = JSON.parse(raw);
            } catch {
              // not JSON (e.g. Express's HTML 404) - keep the raw text
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        })
        .on("error", (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const claudeJob: JobConfig = {
  name: "Agent Job",
  schedule: "0 9 * * *",
  directory: "/tmp",
  type: "claude",
  prompt: "hello",
  enabled: true,
  skip_permissions: false,
  tags: [],
};

const scriptJob: JobConfig = {
  ...claudeJob,
  name: "Script Job",
  type: "script",
  prompt: undefined,
  command: "echo hi",
};

describe("GET /api/runs/:jobId/:runId/graph", () => {
  let tmpDir: string;
  let engine: CronEngine;
  let app: ReturnType<typeof createApp>;

  function writeRun(
    jobId: string,
    runId: string,
    jobConfig: JobConfig,
    files: { status?: RunStatusFile; log?: string; trace?: string },
    runDir = path.join(tmpDir, "data", "runs", jobId, runId),
  ): void {
    fs.mkdirSync(runDir, { recursive: true });
    const meta: RunMeta = {
      jobId,
      runId,
      jobConfig,
      trigger: "manual",
      startedAt: "2026-09-28T09:00:00.000Z",
    };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
    if (files.status)
      fs.writeFileSync(
        path.join(runDir, "status.json"),
        JSON.stringify(files.status),
      );
    if (files.log !== undefined)
      fs.writeFileSync(path.join(runDir, "output.log"), files.log);
    if (files.trace !== undefined)
      fs.writeFileSync(path.join(runDir, "trace.jsonl"), files.trace);
  }

  const done: RunStatusFile = {
    status: "success",
    exitCode: 0,
    startedAt: "2026-09-28T09:00:00.000Z",
    finishedAt: "2026-09-28T09:01:00.000Z",
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-graph-"));
    engine = new CronEngine(tmpDir);
    app = createApp(engine, tmpDir, new Date().toISOString());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds the graph from trace.jsonl when the run has one", async () => {
    const trace = [
      {
        kind: "attempt",
        at: "2026-09-28T09:00:00.100Z",
        attempt: 1,
        version: 1,
      },
      {
        kind: "session",
        at: "2026-09-28T09:00:01.000Z",
        attempt: 1,
        model: "claude-sonnet-4-5",
        cliVersion: "2.1.283",
      },
      {
        kind: "text",
        at: "2026-09-28T09:00:02.000Z",
        attempt: 1,
        parent: null,
        messageId: "m1",
        text: "Checking.",
      },
      {
        kind: "tool_use",
        at: "2026-09-28T09:00:02.500Z",
        attempt: 1,
        parent: null,
        messageId: "m1",
        id: "toolu_1",
        name: "Bash",
        summary: "$ ls",
        path: null,
        agent: null,
      },
      {
        kind: "tool_result",
        at: "2026-09-28T09:00:03.000Z",
        attempt: 1,
        parent: null,
        id: "toolu_1",
        isError: false,
        preview: "a.txt",
      },
      {
        kind: "result",
        at: "2026-09-28T09:00:04.000Z",
        attempt: 1,
        isError: false,
        subtype: "success",
        durationMs: 3900,
        numTurns: 2,
        costUsd: 0.02,
        permissionDenials: 0,
        text: "Done.",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    // The live run is still writing its next line.
    writeRun("agent-job", "run-traced", claudeJob, {
      status: done,
      log: "> [Bash] $ ls\n> [Bash] $ pwd\n",
      trace: `${trace}\n{"kind":"te`,
    });

    const res = await request(app, "/api/runs/agent-job/run-traced/graph");
    expect(res.status).toBe(200);
    const graph = res.body as RunGraph;
    expect(graph).toMatchObject({
      jobId: "agent-job",
      runId: "run-traced",
      kind: "agent",
      source: "trace",
      status: "success",
      exitCode: 0,
    });
    expect(graph.attempts[0].model).toBe("claude-sonnet-4-5");
    expect(graph.attempts[0].lane?.steps[0]).toMatchObject({
      narration: "Checking.",
    });
    expect(graph.attempts[0].lane?.steps[0].calls[0]).toMatchObject({
      id: "toolu_1",
      status: "ok",
      durationMs: 500,
      resultPreview: "a.txt",
    });
    // Built from the trace, not the two Bash lines in output.log.
    expect(graph.totals.toolCalls).toBe(1);
  });

  it("reconstructs a Claude run recorded before tracing from output.log", async () => {
    writeRun("agent-job", "run-legacy", claudeJob, {
      status: { ...done, status: "failed", exitCode: 1 },
      log: "Looking around.\n> [Read] Reading /repo/a.ts\n1\tconst a = 1;\n\n> [Bash] $ npm test\nFAIL\n",
    });

    const res = await request(app, "/api/runs/agent-job/run-legacy/graph");
    expect(res.status).toBe(200);
    const graph = res.body as RunGraph;
    expect(graph).toMatchObject({
      source: "log",
      kind: "agent",
      status: "failed",
      exitCode: 1,
    });
    expect(graph.attempts[0].lane?.status).toBe("error");
    expect(
      graph.attempts[0].lane?.steps[0].calls.map((call) => call.name),
    ).toEqual(["Read", "Bash"]);
    expect(graph.totals.filesRead).toEqual(["/repo/a.ts"]);
  });

  it("splits a script run's output into sections", async () => {
    writeRun("script-job", "run-script", scriptJob, {
      status: { ...done, status: "partial", exitCode: 2 },
      log: "=== Build ===\nok\n=== Test ===\nError: 1 failing\nFAILED: test\n=== Done ===\n",
    });

    const res = await request(app, "/api/runs/script-job/run-script/graph");
    expect(res.status).toBe(200);
    const graph = res.body as RunGraph;
    expect(graph).toMatchObject({
      source: "script-log",
      kind: "script",
      status: "partial",
    });
    expect(graph.attempts[0].lane).toBeNull();
    expect(
      graph.attempts[0].sections.map((section) => [
        section.title,
        section.failed,
      ]),
    ).toEqual([
      ["Build", false],
      ["Test", true],
      ["Done", false],
    ]);
  });

  it("treats a run without status.json as running", async () => {
    writeRun("agent-job", "run-starting", claudeJob, {
      log: "> [Bash] $ ls\n",
    });

    const res = await request(app, "/api/runs/agent-job/run-starting/graph");
    expect(res.status).toBe(200);
    const graph = res.body as RunGraph;
    expect(graph).toMatchObject({
      status: "running",
      exitCode: null,
      startedAt: "2026-09-28T09:00:00.000Z",
      finishedAt: null,
    });
    expect(graph.attempts[0].lane?.status).toBe("running");
  });

  it("returns 404 for a run that does not exist", async () => {
    fs.mkdirSync(path.join(tmpDir, "data", "runs", "agent-job"), {
      recursive: true,
    });
    expect(await request(app, "/api/runs/agent-job/nope/graph")).toEqual({
      status: 404,
      body: { error: "Run not found" },
    });
    expect(await request(app, "/api/runs/no-job/nope/graph")).toEqual({
      status: 404,
      body: { error: "Run not found" },
    });
  });

  it("returns 404 for ids that would escape the runs directory", async () => {
    // A decoy run reachable only through traversal: data/runs/../decoy and
    // data/runs/agent-job/../../decoy both resolve to data/decoy.
    writeRun(
      "decoy",
      "decoy",
      claudeJob,
      { status: done, log: "> [Bash] $ cat secrets\n" },
      path.join(tmpDir, "data", "decoy"),
    );
    fs.mkdirSync(path.join(tmpDir, "data", "runs", "agent-job"), {
      recursive: true,
    });

    for (const url of [
      "/api/runs/../decoy/graph",
      "/api/runs/agent-job/..%2F..%2Fdecoy/graph",
      "/api/runs/%2E%2E/decoy/graph",
      "/api/runs/agent-job/../graph",
    ]) {
      expect(await request(app, url), url).toEqual({
        status: 404,
        body: { error: "Run not found" },
      });
    }
  });

  it("returns 404 for the per-job latest symlink", async () => {
    writeRun("agent-job", "run-real", claudeJob, { status: done, log: "" });
    fs.symlinkSync(
      "run-real",
      path.join(tmpDir, "data", "runs", "agent-job", "latest"),
    );
    expect(await request(app, "/api/runs/agent-job/latest/graph")).toEqual({
      status: 404,
      body: { error: "Run not found" },
    });
  });

  it("returns 404 for any spelling of latest and for symlinked job or run directories, like the run endpoint", async () => {
    const runsDir = path.join(tmpDir, "data", "runs");
    writeRun("agent-job", "run-real", claudeJob, { status: done, log: "" });
    fs.symlinkSync("run-real", path.join(runsDir, "agent-job", "latest"));
    // Complete runs kept outside data/runs, reachable only through symlinks.
    writeRun(
      "agent-job",
      "run-outside",
      claudeJob,
      { status: done, log: "> [Bash] $ cat secrets\n" },
      path.join(tmpDir, "outside", "run-outside"),
    );
    fs.symlinkSync(
      path.join(tmpDir, "outside", "run-outside"),
      path.join(runsDir, "agent-job", "linked-run"),
    );
    writeRun(
      "linked-job",
      "run-1",
      claudeJob,
      { status: done, log: "" },
      path.join(tmpDir, "outside-job", "run-1"),
    );
    fs.symlinkSync(
      path.join(tmpDir, "outside-job"),
      path.join(runsDir, "linked-job"),
    );

    for (const url of [
      "/api/runs/agent-job/LATEST/graph",
      "/api/runs/agent-job/Latest/graph",
      "/api/runs/agent-job/linked-run/graph",
      "/api/runs/linked-job/run-1/graph",
    ]) {
      expect(await request(app, url), url).toEqual({
        status: 404,
        body: { error: "Run not found" },
      });
    }
    // The real run is still served.
    expect(
      (await request(app, "/api/runs/agent-job/run-real/graph")).status,
    ).toBe(200);
  });

  it("splits a reconstructed log into no more attempts than costs.json recorded", async () => {
    // One attempt; a Bash call printed another run's log, retry marker included.
    const log = [
      "> [Bash] $ tail data/runs/speedboat-cycle-cron/latest/output.log",
      "schedule-gate: getRoster failed: HTTP 404",
      "",
      "=== retry 1/3 (previous attempt: failed) ===",
      "nothing to do today",
      "> [Write] Writing /repo/review.md",
      "",
    ].join("\n");
    const costs = (attempts: number[]) =>
      JSON.stringify({
        version: 1,
        attempts: attempts.map((attempt) => ({
          attempt,
          complete: true,
          entries: [],
        })),
        updatedAt: "2026-09-28T09:01:00.000Z",
      });
    writeRun("agent-job", "run-once", claudeJob, { status: done, log });
    fs.writeFileSync(
      path.join(tmpDir, "data", "runs", "agent-job", "run-once", "costs.json"),
      costs([1]),
    );
    const once = (await request(app, "/api/runs/agent-job/run-once/graph"))
      .body as RunGraph;
    expect(once.attempts).toHaveLength(1);
    expect(
      once.attempts[0].lane?.steps[0].calls.map((call) => call.name),
    ).toEqual(["Bash", "Write"]);

    // A genuine retry is still split when costs.json recorded both attempts.
    writeRun("agent-job", "run-twice", claudeJob, { status: done, log });
    fs.writeFileSync(
      path.join(tmpDir, "data", "runs", "agent-job", "run-twice", "costs.json"),
      costs([1, 2]),
    );
    const twice = (await request(app, "/api/runs/agent-job/run-twice/graph"))
      .body as RunGraph;
    expect(twice.attempts).toHaveLength(2);
  });

  it("returns 500 without leaking details when the run cannot be read", async () => {
    writeRun("agent-job", "run-broken", claudeJob, { status: done });
    // A directory where trace.jsonl should be: reading it fails with EISDIR.
    fs.mkdirSync(
      path.join(
        tmpDir,
        "data",
        "runs",
        "agent-job",
        "run-broken",
        "trace.jsonl",
      ),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app, "/api/runs/agent-job/run-broken/graph");
    expect(res).toEqual({
      status: 500,
      body: { error: "Could not build the run graph" },
    });
    expect(errorLog).toHaveBeenCalled();
  });
});
