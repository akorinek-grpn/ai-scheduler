import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ingestInnerSessions, sessionCostEntries } from "../inner-sessions";
import { runJob } from "../job-runner";
import { readRunCost } from "../costs";
import { buildEvaluationRecord } from "../evaluation-log";
import { readRunSummary } from "../run-history";
import type { JobConfig } from "@shared/types";

// Script runs (the autopilot) said executionCostUsd: null in every cost view until 2026-10-16:
// their work happens in an inner `claude -p` session whose transcript carries token usage per
// API call but no dollars. The daemon now prices that usage at list price (shared/model-prices.ts).

const ID = "2024fe43-2e2f-40bc-a179-ff05304493cc";
const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
const usage = {
  input_tokens: 500,
  output_tokens: 100,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 2500,
  cache_creation: { ephemeral_1h_input_tokens: 1500, ephemeral_5m_input_tokens: 1000 },
};
const assistant = (at: string, id: string, model: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", timestamp: at, sessionId: ID, cwd: "/work/x", message: { id, role: "assistant", model, usage, content }, ...extra });

/** One Opus 5.5 response logged twice (two content blocks) plus one subagent (sidechain) call. */
const transcript = (model = "claude-opus-5-5"): string =>
  [
    line({ type: "user", timestamp: "2026-10-16T10:00:00.000Z", sessionId: ID, cwd: "/work/x", message: { role: "user", content: "go" } }),
    assistant("2026-10-16T10:00:01.000Z", "msg_1", model, [{ type: "text", text: "Looking." }]),
    assistant("2026-10-16T10:00:01.000Z", "msg_1", model, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    assistant("2026-10-16T10:00:02.000Z", "msg_2", model, [{ type: "text", text: "Subagent chatter" }], { isSidechain: true }),
  ].join("\n") + "\n";

// Two calls of 500/100/5000 read/2500 written (1500 of them 1 h): Opus 5.5 at 4/20/0.2/5/8 per M.
const EXPECTED_OPUS_COST = (1000 * 4 + 200 * 20 + 10000 * 0.2 + 2000 * 5 + 3000 * 8) / 1e6; // 0.044

let tmp: string;
let projectsDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-session-cost-"));
  projectsDir = path.join(tmp, "projects");
  fs.mkdirSync(path.join(projectsDir, "-work-x"), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("inner session usage", () => {
  it("tallies each API call once per model, subagent calls included, and prices it", () => {
    fs.writeFileSync(path.join(projectsDir, "-work-x", `${ID}.jsonl`), transcript());
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, "output.log"), `running /pr-fixup (headless, session ${ID})\n`);
    const [session] = ingestInnerSessions(runDir, { projectsDir, final: true });
    expect(session.usage).toEqual([
      {
        model: "claude-opus-5-5",
        calls: 2,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 10000,
        cacheWriteTokens: 5000,
        cacheWrite1hTokens: 3000,
        costUsd: expect.closeTo(EXPECTED_OPUS_COST, 9),
      },
    ]);
    expect(session.costUsd).toBeCloseTo(EXPECTED_OPUS_COST, 9);
    // The log still leaves the sidechain out.
    expect(fs.readFileSync(path.join(runDir, "session.log"), "utf8")).not.toContain("Subagent chatter");
    const [entry] = sessionCostEntries([session]);
    expect(entry).toMatchObject({
      id: `session:${ID}`,
      source: "claude",
      costUsd: expect.closeTo(EXPECTED_OPUS_COST, 9),
      tokens: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000, cacheWriteTokens: 5000 },
      models: [{ model: "claude-opus-5-5", costUsd: expect.closeTo(EXPECTED_OPUS_COST, 9) }],
    });
  });

  it("keeps the tokens and reports no dollars for a model without a list price", () => {
    fs.writeFileSync(path.join(projectsDir, "-work-x", `${ID}.jsonl`), transcript("claude-opus-9"));
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, "output.log"), `session ${ID}\n`);
    const [session] = ingestInnerSessions(runDir, { projectsDir, final: true });
    expect(session.usage?.[0]).toMatchObject({ model: "claude-opus-9", inputTokens: 1000, costUsd: null });
    expect(session.costUsd).toBeNull();
    expect(sessionCostEntries([session])[0]).toMatchObject({ costUsd: null, models: [{ model: "claude-opus-9", costUsd: null }] });
  });
});

describe("a script run with an inner session", () => {
  const job: JobConfig = {
    name: "Autopilot Babysit",
    schedule: "50 * * * *",
    directory: os.tmpdir(),
    type: "script",
    command: "unused",
    enabled: true,
    tags: [],
  };

  it("carries the session's cost and models in costs.json, the run summary and the ledger record", async () => {
    fs.writeFileSync(path.join(projectsDir, "-work-x", `${ID}.jsonl`), transcript());
    const previous = process.env.HOME;
    // inner-sessions.ts looks in ~/.claude/projects; point HOME at the fixture.
    fs.mkdirSync(path.join(tmp, "home", ".claude"), { recursive: true });
    fs.symlinkSync(projectsDir, path.join(tmp, "home", ".claude", "projects"));
    process.env.HOME = path.join(tmp, "home");
    try {
      const run = await runJob({
        jobId: "autopilot-babysit",
        jobConfig: job,
        projectRoot: tmp,
        trigger: "scheduled",
        command: "sh",
        args: ["-c", `echo "running /pr-fixup on PR #1 (headless, session ${ID}, hard deadline 50m)"`],
      });
      expect(run.status).toBe("success");
      const cost = readRunCost(tmp, "autopilot-babysit", run.runId);
      expect(cost.executionCostUsd).toBeCloseTo(EXPECTED_OPUS_COST, 9);
      expect(cost.attempts[0]).toMatchObject({ complete: true });
      expect(cost.attempts[0].entries.map((entry) => entry.id)).toEqual([`session:${ID}`]);
      const summary = readRunSummary(tmp, "autopilot-babysit", run.runId)!;
      expect(summary.innerSessions).toBe(1);
      const record = buildEvaluationRecord(summary, null);
      expect(record.executionCostUsd).toBeCloseTo(EXPECTED_OPUS_COST, 9);
      expect(record.executionModels).toEqual(["claude-opus-5-5"]);
    } finally {
      process.env.HOME = previous;
    }
  });

  it("a script's own cost report and its session's cost add up, and an unpriced session keeps the attempt partial", async () => {
    fs.writeFileSync(path.join(projectsDir, "-work-x", `${ID}.jsonl`), transcript("claude-opus-9"));
    const previous = process.env.HOME;
    fs.mkdirSync(path.join(tmp, "home", ".claude"), { recursive: true });
    fs.symlinkSync(projectsDir, path.join(tmp, "home", ".claude", "projects"));
    process.env.HOME = path.join(tmp, "home");
    try {
      const run = await runJob({
        jobId: "autopilot-babysit",
        jobConfig: job,
        projectRoot: tmp,
        trigger: "scheduled",
        command: "sh",
        args: [
          "-c",
          `echo "session ${ID}"; echo '{"type":"scheduler_cost","id":"scorer","currency":"USD","cost_usd":0.5}'; echo '{"type":"scheduler_cost_complete"}'`,
        ],
      });
      const cost = readRunCost(tmp, "autopilot-babysit", run.runId);
      // The scorer's 0.5 is known; the session's dollars are not, so the total is a partial 0.5.
      expect(cost.executionCostUsd).toBe(0.5);
      expect(cost.coverage).toBe("partial");
      expect(cost.attempts[0].entries.map((entry) => entry.id).sort()).toEqual(["scorer", `session:${ID}`]);
    } finally {
      process.env.HOME = previous;
    }
  });
});
