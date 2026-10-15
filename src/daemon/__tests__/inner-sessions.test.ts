import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findSessionIds, ingestInnerSessions } from "../inner-sessions";

const ID = "2024fe43-2e2f-40bc-a179-ff05304493cc";
const ID2 = "9b1c0d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";

/** One Claude Code transcript line. */
const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
const assistant = (at: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", timestamp: at, sessionId: ID, cwd: "/work/pwa-worktrees/MBNXT-1", message: { role: "assistant", content }, ...extra });
const user = (at: string, content: unknown) =>
  line({ type: "user", timestamp: at, sessionId: ID, cwd: "/work/pwa-worktrees/MBNXT-1", message: { role: "user", content } });

const TRANSCRIPT = [
  line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-15T10:00:00.000Z" }),
  user("2026-10-15T10:00:01.000Z", "Run /pr-fixup on PR #19165"),
  assistant("2026-10-15T10:00:02.000Z", [{ type: "text", text: "Checking the failing lint job." }]),
  assistant("2026-10-15T10:00:03.000Z", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm run lint" } }]),
  line({ type: "attachment", timestamp: "2026-10-15T10:00:03.500Z" }),
  user("2026-10-15T10:00:04.000Z", [{ type: "tool_result", tool_use_id: "tu1", content: "1 error in LocationSelectModal.test.tsx" }]),
  assistant("2026-10-15T10:00:05.000Z", [{ type: "text", text: "Sidechain chatter" }], { isSidechain: true }),
  assistant("2026-10-15T10:00:06.000Z", [{ type: "text", text: "I pushed a fix for the lint failure." }]),
];

describe("findSessionIds", () => {
  it("finds the sessions a script names, once each, in order", () => {
    const log = [
      `[autopilot-babysit] running /pr-fixup on PR #19165 (headless, session ${ID}, hard deadline 50m)`,
      `stage 2: claude -p ... --session-id ${ID2}`,
      `[autopilot-babysit] session ${ID} finished`,
    ].join("\n");
    expect(findSessionIds(log)).toEqual([ID, ID2]);
  });

  it("ignores a UUID that is not called a session", () => {
    expect(findSessionIds(`attempt ${ID} recorded`)).toEqual([]);
  });
});

describe("ingestInnerSessions", () => {
  let tmp: string;
  let runDir: string;
  let projectsDir: string;
  let transcript: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-inner-"));
    runDir = path.join(tmp, "data", "runs", "autopilot-babysit", "r1");
    projectsDir = path.join(tmp, "projects");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(projectsDir, "-work-pwa-worktrees-MBNXT-1"), { recursive: true });
    transcript = path.join(projectsDir, "-work-pwa-worktrees-MBNXT-1", `${ID}.jsonl`);
    fs.writeFileSync(transcript, TRANSCRIPT.join("\n") + "\n");
    fs.writeFileSync(
      path.join(runDir, "output.log"),
      `MBNXT-1 PR #19165: babysit\n[autopilot-babysit] running /pr-fixup (headless, session ${ID}, hard deadline 50m)\n`,
    );
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const read = (name: string) => fs.readFileSync(path.join(runDir, name), "utf8");
  const traceKinds = () => read("trace.jsonl").trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);

  it("copies the session's text and tool calls into session.log, without sidechain lines", () => {
    const sessions = ingestInnerSessions(runDir, { projectsDir, final: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: ID, cwd: "/work/pwa-worktrees/MBNXT-1", toolCalls: 1 });
    const log = read("session.log");
    expect(log).toContain(ID);
    expect(log).toContain("Checking the failing lint job.");
    expect(log).toContain("> [Bash] $ npm run lint");
    expect(log).toContain("1 error in LocationSelectModal.test.tsx");
    expect(log).toContain("I pushed a fix for the lint failure.");
    expect(log).not.toContain("Sidechain chatter");
    expect(JSON.parse(read("sessions.json"))).toHaveLength(1);
  });

  it("writes the trace behind the Diagram, with the outcome only once the run is final", () => {
    ingestInnerSessions(runDir, { projectsDir, final: false });
    expect(traceKinds()[0]).toBe("attempt");
    expect(traceKinds()).toContain("tool_use");
    expect(traceKinds()).toContain("tool_result");
    expect(traceKinds()).not.toContain("result");
    ingestInnerSessions(runDir, { projectsDir, final: true });
    expect(traceKinds().at(-1)).toBe("result");
    const result = JSON.parse(read("trace.jsonl").trim().split("\n").at(-1)!) as { text: string };
    expect(result.text).toContain("I pushed a fix");
  });

  it("only appends while a live session grows, so the log viewer's offsets stay valid", () => {
    ingestInnerSessions(runDir, { projectsDir, final: false });
    const before = read("session.log");
    fs.appendFileSync(transcript, assistant("2026-10-15T10:00:07.000Z", [{ type: "text", text: "CI is green now." }]) + "\n");
    ingestInnerSessions(runDir, { projectsDir, final: false });
    const after = read("session.log");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain("CI is green now.");
  });

  it("writes nothing for a run that names no session or whose transcript is missing", () => {
    fs.writeFileSync(path.join(runDir, "output.log"), "no pipeline PR is in flight\n");
    expect(ingestInnerSessions(runDir, { projectsDir, final: true })).toEqual([]);
    fs.writeFileSync(path.join(runDir, "output.log"), `session ${ID2}\n`);
    expect(ingestInnerSessions(runDir, { projectsDir, final: true })).toEqual([]);
    expect(fs.existsSync(path.join(runDir, "session.log"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "trace.jsonl"))).toBe(false);
  });
});

describe("the session view through the API", () => {
  let root: string;
  let engine: import("../cron-engine").CronEngine;

  afterEach(() => {
    engine?.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function get(app: import("express").Express, url: string): Promise<{ status: number; body: any }> {
    const http = await import("http");
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
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
            });
          })
          .on("error", (err) => {
            server.close();
            reject(err);
          });
      });
    });
  }

  it("serves session.log with file=session and counts the run's sessions", async () => {
    const { createApp } = await import("../api");
    const { CronEngine } = await import("../cron-engine");
    const { loadConfig } = await import("../config");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-inner-api-"));
    fs.writeFileSync(
      path.join(root, "scheduler.yaml"),
      `version: 1\njobs:\n  autopilot-babysit:\n    name: Autopilot Babysit\n    schedule: "50 * * * *"\n    directory: /tmp\n    type: script\n    command: "true"\n`,
    );
    const runDir = path.join(root, "data", "runs", "autopilot-babysit", "r1");
    const projectsDir = path.join(root, "projects", "-work");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    const startedAt = "2026-10-15T10:00:00.000Z";
    fs.writeFileSync(
      path.join(runDir, "meta.json"),
      JSON.stringify({ jobId: "autopilot-babysit", runId: "r1", trigger: "scheduled", startedAt, jobConfig: { name: "Autopilot Babysit", schedule: "50 * * * *", directory: "/tmp", type: "script", command: "true", enabled: true, skip_permissions: false, tags: [] } }),
    );
    fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ status: "success", exitCode: 0, startedAt, finishedAt: startedAt }));
    fs.writeFileSync(path.join(runDir, "output.log"), `running /pr-fixup (headless, session ${ID})\n`);
    fs.writeFileSync(path.join(projectsDir, `${ID}.jsonl`), TRANSCRIPT.join("\n") + "\n");
    ingestInnerSessions(runDir, { projectsDir: path.join(root, "projects"), final: true });

    const loaded = loadConfig(path.join(root, "scheduler.yaml"));
    if (!loaded.success) throw new Error(loaded.error);
    engine = new CronEngine(root);
    engine.loadJobs(loaded.data);
    const app = createApp(engine, root, new Date().toISOString());

    const session = await get(app, "/api/runs/autopilot-babysit/r1/log?file=session&offset=0");
    expect(session.status).toBe(200);
    expect(session.body.content).toContain("I pushed a fix for the lint failure.");
    const script = await get(app, "/api/runs/autopilot-babysit/r1/log?offset=0");
    expect(script.body.content).toContain("running /pr-fixup");
    expect((await get(app, "/api/runs/autopilot-babysit/r1/log?file=../meta.json")).status).toBe(400);
    const runs = await get(app, "/api/runs?job=autopilot-babysit");
    expect(runs.body[0]).toMatchObject({ runId: "r1", innerSessions: 1 });
    const graph = await get(app, "/api/runs/autopilot-babysit/r1/graph");
    expect(graph.status).toBe(200);
    expect(graph.body.kind).toBe("agent");
    expect(JSON.stringify(graph.body)).toContain("npm run lint");
  });
});
