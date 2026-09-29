import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunTraceWriter, traceEventsFromStreamLine } from "../run-trace";
import { runJob } from "../job-runner";
import { getLogPath, getTracePath } from "@shared/paths";
import type { JobConfig } from "@shared/types";
import {
  TRACE_MAX_EVENTS,
  TRACE_PREVIEW_LIMIT,
  TRACE_SUMMARY_LIMIT,
  TRACE_TEXT_LIMIT,
  type TraceEvent,
  type TraceToolUseEvent,
} from "@shared/run-trace-types";

// Sanitized capture of a real `claude -p --verbose --output-format stream-json`
// run (CLI 2.1.283): Glob, Read, a failing Read, an async Agent whose subagent
// reads a file, a second failing Read, then the final result.
const FIXTURE = path.join(__dirname, "fixtures", "stream-json-sample.jsonl");
const fixtureLines = fs
  .readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter(Boolean);
// output.log for one run of FIXTURE, written by job-runner.ts with the trace
// wiring removed (and identical to the pre-Diagram runner's output).
const FIXTURE_LOG = path.join(
  __dirname,
  "fixtures",
  "stream-json-sample.output.log",
);
// Sanitized capture of a real run (CLI 2.1.283) that starts a Bash command with
// run_in_background, is notified that it finished, then reads its output file.
const BG_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "stream-json-bg-sample.jsonl",
);

const AGENT_ID = "toolu_01BBAo2NqZw2Gdd88QFCYUsW";
const NOW = "2026-01-01T00:00:00.000Z";
const now = () => NOW;

/** The fixture line whose JSON satisfies `pick`. */
function fixtureLine(pick: (event: Record<string, any>) => boolean): string {
  const line = fixtureLines.find((l) => pick(JSON.parse(l)));
  if (!line) throw new Error("fixture line not found");
  return line;
}

function mapOne(event: unknown, at = now): TraceEvent[] {
  return traceEventsFromStreamLine(JSON.stringify(event), 1, at);
}

function toolUse(name: string, input: unknown): TraceToolUseEvent {
  const [event] = mapOne({
    type: "assistant",
    message: {
      id: "msg_1",
      content: [{ type: "tool_use", id: "toolu_x", name, input }],
    },
    parent_tool_use_id: null,
  });
  if (event?.kind !== "tool_use") throw new Error("expected a tool_use event");
  return event;
}

function readTrace(file: string): TraceEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("traceEventsFromStreamLine on the real stream-json sample", () => {
  const events = fixtureLines.flatMap((l) =>
    traceEventsFromStreamLine(l, 1, now),
  );

  it("keeps the run's meaningful events in stream order and drops the noise", () => {
    expect(events.map((e) => e.kind)).toEqual([
      "session",
      "text", // "I'll work through these steps in sequence."
      "tool_use",
      "tool_result", // Glob
      "tool_use",
      "tool_result", // Read a.txt
      "tool_use",
      "tool_result", // Read missing.txt (error)
      "tool_use", // Agent
      "subagent", // task_started
      "tool_result", // "Async agent launched successfully..."
      "tool_use",
      "tool_result", // subagent Read b.txt
      "text", // subagent's answer
      "subagent", // task_notification
      "text",
      "tool_use",
      "tool_result", // Read of the task output file (error)
      "text",
      "result",
    ]);
  });

  it("ignores hooks, thinking tokens/blocks, rate limits and task progress events", () => {
    const noise = fixtureLines.filter((l) => {
      const e = JSON.parse(l);
      return (
        e.type === "rate_limit_event" ||
        (e.type === "system" &&
          [
            "hook_started",
            "hook_response",
            "thinking_tokens",
            "background_tasks_changed",
            "task_progress",
            "task_updated",
          ].includes(e.subtype)) ||
        (e.type === "assistant" && e.message.content[0].type === "thinking")
      );
    });
    expect(noise.length).toBeGreaterThanOrEqual(10);
    for (const line of noise)
      expect(traceEventsFromStreamLine(line, 1, now)).toEqual([]);
  });

  it("maps system/init to a session event stamped with now()", () => {
    expect(events[0]).toEqual({
      kind: "session",
      at: NOW,
      attempt: 1,
      model: "claude-haiku-4-5-20251001",
      cliVersion: "2.1.283",
    });
  });

  it("maps assistant text and tool_use blocks with the CLI's timestamp and message id", () => {
    expect(events[1]).toEqual({
      kind: "text",
      at: "2026-09-28T09:28:36.623Z",
      attempt: 1,
      parent: null,
      messageId: "msg_011CfVbp8SEd2WU9UyNjFqBK",
      text: "I'll work through these steps in sequence.",
    });
    expect(events[2]).toEqual({
      kind: "tool_use",
      at: "2026-09-28T09:28:36.853Z",
      attempt: 1,
      parent: null,
      messageId: "msg_011CfVbp8SEd2WU9UyNjFqBK",
      id: "toolu_012vLT7ck1s1QXRjcnkzBrkC",
      name: "Glob",
      summary: "*.txt",
      path: null,
      agent: null,
    });
  });

  it("maps tool results with collapsed-whitespace previews and the error flag", () => {
    expect(events[3]).toEqual({
      kind: "tool_result",
      at: "2026-09-28T09:28:36.961Z",
      attempt: 1,
      parent: null,
      id: "toolu_012vLT7ck1s1QXRjcnkzBrkC",
      isError: false,
      preview: "a.txt b.txt stderr.txt",
    });
    expect(events[5]).toMatchObject({
      id: "toolu_016KQcunkzY7fyDtVcKFM1d4",
      isError: false,
      preview: "1 hello 2",
    });

    expect(events[6]).toMatchObject({
      kind: "tool_use",
      name: "Read",
      id: "toolu_01HD4WjwjSVVQSDeToRRLodg",
      summary: "/work/sample/missing.txt",
      path: "/work/sample/missing.txt",
    });
    expect(events[7]).toMatchObject({
      kind: "tool_result",
      id: "toolu_01HD4WjwjSVVQSDeToRRLodg",
      isError: true,
    });
    expect((events[7] as { preview: string }).preview).toMatch(
      /^File does not exist\./,
    );
    expect(events[17]).toMatchObject({
      kind: "tool_result",
      id: "toolu_01WGHmbh1Xtn9BTpFC4USMyR",
      isError: true,
    });
  });

  it("records the Agent call's subagent and the async agent's lifecycle", () => {
    expect(events[8]).toMatchObject({
      kind: "tool_use",
      id: AGENT_ID,
      name: "Agent",
      summary: "count words",
      path: null,
      agent: { description: "count words", subagentType: "general-purpose" },
    });
    expect(events[9]).toEqual({
      kind: "subagent",
      at: NOW,
      attempt: 1,
      toolUseId: AGENT_ID,
      status: "started",
      summary: null,
      toolUses: null,
      durationMs: null,
    });
    // The async launch returns immediately with a long text-block result; the
    // CLI marks it with tool_use_result.isAsync, so it is flagged as a launch.
    const launch = events[10] as Extract<TraceEvent, { kind: "tool_result" }>;
    expect(launch).toMatchObject({
      kind: "tool_result",
      parent: null,
      id: AGENT_ID,
      isError: false,
      launched: true,
    });
    expect(
      launch.preview.startsWith("Async agent launched successfully."),
    ).toBe(true);
    expect(launch.preview).toHaveLength(TRACE_PREVIEW_LIMIT);
    expect(launch.preview.endsWith("…")).toBe(true);
    expect(launch.preview).not.toMatch(/\n/);

    expect(events[14]).toEqual({
      kind: "subagent",
      at: NOW,
      attempt: 1,
      toolUseId: AGENT_ID,
      status: "completed",
      summary: 'The file `b.txt` contains **1 word**: "world"',
      toolUses: 1,
      durationMs: 3681,
    });
  });

  it("flags only the async launch acknowledgement as launched", () => {
    // The other results' tool_use_result is a Glob/Read result object, an
    // error string or absent: they report finished work.
    const results = events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(6);
    expect(results.filter((e) => "launched" in e)).toEqual([events[10]]);
  });

  it("links the subagent's own activity to the spawning Agent call", () => {
    expect(events[11]).toMatchObject({
      kind: "tool_use",
      parent: AGENT_ID,
      messageId: "msg_011CfVbpnRUpxpv7vWLr9Esd",
      id: "toolu_01Qj6ppXnsX7YSXdUy8PiPyw",
      name: "Read",
      path: "/work/sample/b.txt",
    });
    expect(events[12]).toMatchObject({
      kind: "tool_result",
      parent: AGENT_ID,
      id: "toolu_01Qj6ppXnsX7YSXdUy8PiPyw",
      preview: "1 world 2",
    });
    expect(events[13]).toMatchObject({
      kind: "text",
      parent: AGENT_ID,
      text: 'The file `b.txt` contains **1 word**: "world"',
    });
    // The main agent's later activity is not attributed to the subagent.
    expect(events[15]).toMatchObject({ kind: "text", parent: null });
  });

  it("maps the final result event", () => {
    expect(events[19]).toEqual({
      kind: "result",
      at: NOW,
      attempt: 1,
      isError: false,
      subtype: "success",
      durationMs: 22541,
      numTurns: 6,
      costUsd: 0.18102884999999996,
      permissionDenials: 0,
      text: 'All five steps completed: found 3 .txt files, read a.txt ("hello"), confirmed missing.txt doesn\'t exist, and the agent reported b.txt contains 1 word ("world").',
    });
  });

  it("stamps events with the attempt it is given", () => {
    const line = fixtureLine(
      (e) => e.type === "assistant" && e.message.content[0].name === "Glob",
    );
    expect(traceEventsFromStreamLine(line, 3, now)[0].attempt).toBe(3);
  });
});

describe("traceEventsFromStreamLine on the real background Bash sample", () => {
  const BASH_ID = "toolu_01Wu1JE2Vxm37Wfqv6H3ixRA";
  const READ_ID = "toolu_017pzNHAAvoPodLw1H7uh8tT";
  const events = fs
    .readFileSync(BG_FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => traceEventsFromStreamLine(l, 1, now));

  it("flags the run_in_background acknowledgement as launched, not the later Read", () => {
    // The CLI reports the task's lifecycle (keyed by the Bash tool_use id)
    // before it emits the Bash call's immediate "running in background" result.
    expect(events.map((e) => e.kind)).toEqual([
      "session",
      "tool_use", // Bash, run_in_background: true
      "subagent", // task_started
      "subagent", // task_notification: completed
      "tool_result", // "Command running in background with ID: ..."
      "tool_use", // Read of the task's output file
      "tool_result",
      "text",
      "result",
    ]);
    expect(events[1]).toMatchObject({
      kind: "tool_use",
      id: BASH_ID,
      name: "Bash",
      summary: "$ sleep 3 && echo bg-done",
    });
    expect(events[2]).toMatchObject({ toolUseId: BASH_ID, status: "started" });
    expect(events[3]).toMatchObject({
      toolUseId: BASH_ID,
      status: "completed",
      summary:
        'Background command "Run background task with sleep" completed (exit code 0)',
    });
    expect(events[4]).toMatchObject({
      kind: "tool_result",
      id: BASH_ID,
      isError: false,
      launched: true,
    });
    expect((events[4] as { preview: string }).preview).toMatch(
      /^Command running in background with ID: bynttn75p\./,
    );
    expect(events[6]).toMatchObject({ kind: "tool_result", id: READ_ID });
    expect(events[6]).not.toHaveProperty("launched");
  });

  it("does not flag results whose tool_use_result is not a launch", () => {
    const result = (toolUseResult: unknown) =>
      mapOne({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
        },
        tool_use_result: toolUseResult,
      })[0];
    expect(result({ isAsync: true })).toMatchObject({ launched: true });
    expect(result({ backgroundTaskId: "b1" })).toMatchObject({
      launched: true,
    });
    for (const notLaunch of [
      undefined,
      null,
      "Error: boom",
      { isAsync: false, status: "completed" },
      { isAsync: "true" },
      { backgroundTaskId: 7 },
      { stdout: "done", stderr: "", interrupted: false },
      [{ isAsync: true }],
    ]) {
      expect(result(notLaunch)).not.toHaveProperty("launched");
    }
  });
});

describe("traceEventsFromStreamLine tool summaries", () => {
  it("summarizes Bash as the first command line, marking multi-line commands", () => {
    expect(toolUse("Bash", { command: "npm test" }).summary).toBe("$ npm test");
    expect(
      toolUse("Bash", { command: "npm ci\nnpm test", description: "install" })
        .summary,
    ).toBe("$ npm ci …");
  });

  it("summarizes file tools by path and records the path", () => {
    for (const name of ["Read", "Write", "Edit", "MultiEdit"]) {
      expect(
        toolUse(name, { file_path: "/work/src/a.ts", old_string: "x" }),
      ).toMatchObject({
        summary: "/work/src/a.ts",
        path: "/work/src/a.ts",
      });
    }
    expect(
      toolUse("NotebookEdit", {
        notebook_path: "/work/n.ipynb",
        new_source: "x",
      }),
    ).toMatchObject({
      summary: "/work/n.ipynb",
      path: "/work/n.ipynb",
    });
  });

  it("summarizes search, skill, web, task and todo tools", () => {
    expect(toolUse("Glob", { pattern: "**/*.ts" }).summary).toBe("**/*.ts");
    expect(
      toolUse("Grep", { pattern: "TODO", path: "src/daemon" }).summary,
    ).toBe("TODO in src/daemon");
    expect(
      toolUse("Skill", { skill: "ai-scheduler", args: "list" }).summary,
    ).toBe("ai-scheduler");
    expect(
      toolUse("WebFetch", { url: "https://example.com/a", prompt: "summarize" })
        .summary,
    ).toBe("https://example.com/a");
    expect(toolUse("WebSearch", { query: "node streams" }).summary).toBe(
      "node streams",
    );
    expect(
      toolUse("TaskCreate", {
        subject: "Write tests",
        description: "all of them",
      }).summary,
    ).toBe("Write tests");
    expect(
      toolUse("TodoWrite", {
        todos: [{ content: "a" }, { content: "b" }, { content: "c" }],
      }).summary,
    ).toBe("3 todos");
  });

  it("treats the older Task tool as a subagent spawner like Agent", () => {
    expect(
      toolUse("Task", {
        description: "review diff",
        subagent_type: "code-reviewer",
        prompt: "...",
      }),
    ).toMatchObject({
      summary: "review diff",
      agent: { description: "review diff", subagentType: "code-reviewer" },
    });
    expect(toolUse("Agent", { prompt: "no description" }).agent).toEqual({
      description: null,
      subagentType: null,
    });
    expect(toolUse("TaskCreate", { subject: "x" }).agent).toBeNull();
  });

  it("falls back to the first non-empty string input, then to compact JSON", () => {
    expect(
      toolUse("mcp__atlassian__jira_get_issue", {
        limit: 5,
        jql: "  ",
        issue_key: "ABC-1",
      }).summary,
    ).toBe("ABC-1");
    expect(toolUse("mcp__x__count", { n: 3, flag: true }).summary).toBe(
      '{"n":3,"flag":true}',
    );
  });

  it("keeps summaries on one line and within the summary limit", () => {
    expect(
      toolUse("mcp__x__note", { body: "line one\n  line two\r\nline three" })
        .summary,
    ).toBe("line one line two line three");
    const long = toolUse("Bash", {
      command: `echo ${"x".repeat(1000)}`,
    }).summary;
    expect(long).toHaveLength(TRACE_SUMMARY_LIMIT);
    expect(long.startsWith("$ echo xxx")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  it("summarizes inputs with huge whitespace runs quickly, still on one clipped line", () => {
    // The mapper runs synchronously in the daemon's stdout handler, so a tool
    // input with a long whitespace run (no newline) must not stall it.
    const run = (ws: string) => ws.repeat(80_000);
    const cases: [string, Record<string, unknown>, string][] = [
      ["mcp__x__write", { body: `start${run(" ")}end` }, "start"],
      ["Bash", { command: `echo${run("\t")}x\nls` }, "$ echo"],
      ["Grep", { pattern: `a${run(" ")}b`, path: "src" }, "a"],
    ];
    for (const [name, input, prefix] of cases) {
      const started = performance.now();
      const { summary } = toolUse(name, input);
      expect(performance.now() - started).toBeLessThan(100);
      expect(summary.startsWith(prefix)).toBe(true);
      // Text after the whitespace run was dropped, so the cut is marked.
      expect(summary.endsWith("…")).toBe(true);
      expect(summary.length).toBeLessThanOrEqual(TRACE_SUMMARY_LIMIT);
      expect(summary).not.toMatch(/[\r\n]/);
    }
  });

  it("summarizes a too-deeply nested input instead of throwing", () => {
    // JSON.parse accepts this nesting; the compact-JSON fallback's recursive
    // JSON.stringify overflows the stack on it.
    const depth = 10_000;
    const line =
      '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use",' +
      `"id":"toolu_deep","name":"mcp__x__y","input":{"a":${"[".repeat(depth)}${"]".repeat(depth)}}}]}}`;
    const events = traceEventsFromStreamLine(line, 1, now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_use",
      id: "toolu_deep",
      name: "mcp__x__y",
    });
    const { summary } = events[0] as TraceToolUseEvent;
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(TRACE_SUMMARY_LIMIT);
  });

  it("is defensive about missing or odd input", () => {
    expect(toolUse("Read", undefined)).toMatchObject({
      name: "Read",
      path: null,
    });
    expect(toolUse("Bash", { command: 42 })).toMatchObject({ path: null });
    expect(
      toolUse("Read", { file_path: ["not", "a", "string"] }).path,
    ).toBeNull();
    expect(toolUse("Glob", "not an object").summary).not.toMatch(/\n/);
    // tool_use blocks without an id or name cannot be linked to results: dropped.
    expect(
      mapOne({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
      }),
    ).toEqual([]);
  });
});

describe("traceEventsFromStreamLine edge cases", () => {
  it("returns [] for invalid, partial or non-object JSON", () => {
    expect(traceEventsFromStreamLine("not json", 1, now)).toEqual([]);
    expect(
      traceEventsFromStreamLine('{"type":"assistant","message":{"con', 1, now),
    ).toEqual([]);
    expect(traceEventsFromStreamLine("null", 1, now)).toEqual([]);
    expect(traceEventsFromStreamLine("42", 1, now)).toEqual([]);
    expect(traceEventsFromStreamLine("", 1, now)).toEqual([]);
  });

  it("falls back to now() when the event timestamp is missing or not an ISO time", () => {
    const text = (timestamp: unknown) =>
      mapOne({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
        timestamp,
      })[0].at;
    expect(text(undefined)).toBe(NOW);
    expect(text("yesterday")).toBe(NOW);
    expect(text(1790587727039)).toBe(NOW);
    expect(text("2026-09-28T09:28:36.623Z")).toBe("2026-09-28T09:28:36.623Z");
  });

  it("skips empty assistant text and truncates long text to the limit", () => {
    expect(
      mapOne({
        type: "assistant",
        message: { content: [{ type: "text", text: " \n " }] },
      }),
    ).toEqual([]);
    const [event] = mapOne({
      type: "assistant",
      message: { content: [{ type: "text", text: "a".repeat(5000) }] },
    });
    const text = (event as { text: string }).text;
    expect(text).toHaveLength(TRACE_TEXT_LIMIT);
    expect(text.endsWith("…")).toBe(true);
    expect(event).toMatchObject({ parent: null, messageId: null });
  });

  it("previews array tool results, marking images, and ignores user events without results", () => {
    const [result] = mapOne({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_s",
            content: [
              { type: "text", text: "Captured\n\nscreen" },
              { type: "image", source: {} },
            ],
          },
        ],
      },
      parent_tool_use_id: "toolu_parent",
    });
    expect(result).toMatchObject({
      kind: "tool_result",
      id: "toolu_s",
      parent: "toolu_parent",
      isError: false,
    });
    expect((result as { preview: string }).preview).toBe(
      "Captured screen [image]",
    );
    expect(
      mapOne({ type: "user", message: { content: "a plain prompt" } }),
    ).toEqual([]);
    expect(
      mapOne({
        type: "user",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([]);
    expect(
      mapOne({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: "x".repeat(1000),
              is_error: "yes",
            },
          ],
        },
      })[0],
    ).toMatchObject({
      isError: false,
      preview: `${"x".repeat(TRACE_PREVIEW_LIMIT - 1)}…`,
    });
  });

  it("skips subagent lifecycle events without a tool_use_id and nulls odd usage", () => {
    expect(
      mapOne({ type: "system", subtype: "task_started", task_id: "a1" }),
    ).toEqual([]);
    expect(
      mapOne({
        type: "system",
        subtype: "task_notification",
        task_id: "a1",
        status: "completed",
      }),
    ).toEqual([]);
    expect(
      mapOne({
        type: "system",
        subtype: "task_notification",
        tool_use_id: "toolu_a",
        status: "failed",
        usage: { tool_uses: "2", duration_ms: null },
      })[0],
    ).toMatchObject({
      kind: "subagent",
      toolUseId: "toolu_a",
      status: "failed",
      summary: null,
      toolUses: null,
      durationMs: null,
    });
  });

  it("maps error results, counting permission denials and truncating the text", () => {
    expect(
      mapOne({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        permission_denials: [{ tool_name: "Bash" }, { tool_name: "Write" }],
        result: "r".repeat(2000),
      })[0],
    ).toEqual({
      kind: "result",
      at: NOW,
      attempt: 1,
      isError: true,
      subtype: "error_max_turns",
      durationMs: null,
      numTurns: null,
      costUsd: null,
      permissionDenials: 2,
      text: `${"r".repeat(TRACE_TEXT_LIMIT - 1)}…`,
    });
    expect(mapOne({ type: "result" })[0]).toMatchObject({
      isError: false,
      subtype: null,
      permissionDenials: 0,
      text: null,
    });
  });
});

describe("RunTraceWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-run-trace-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const textLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  });

  it("marks each attempt and stamps the events that follow it", async () => {
    const file = path.join(dir, "trace.jsonl");
    const writer = new RunTraceWriter(file, now);
    writer.startAttempt(1);
    writer.consume(textLine);
    writer.consume("not json");
    writer.startAttempt(2);
    writer.consume(textLine);
    await writer.close();

    expect(readTrace(file)).toEqual([
      { kind: "attempt", version: 1, attempt: 1, at: NOW },
      {
        kind: "text",
        at: NOW,
        attempt: 1,
        parent: null,
        messageId: null,
        text: "hi",
      },
      { kind: "attempt", version: 1, attempt: 2, at: NOW },
      {
        kind: "text",
        at: NOW,
        attempt: 2,
        parent: null,
        messageId: null,
        text: "hi",
      },
    ]);
  });

  it("stops at TRACE_MAX_EVENTS with a single truncated event", async () => {
    const file = path.join(dir, "trace.jsonl");
    const writer = new RunTraceWriter(file, now);
    writer.startAttempt(1);
    for (let i = 0; i < TRACE_MAX_EVENTS + 50; i++) writer.consume(textLine);
    writer.startAttempt(2);
    writer.consume(textLine);
    await writer.close();

    const events = readTrace(file);
    expect(events).toHaveLength(TRACE_MAX_EVENTS + 1);
    expect(events[0]).toMatchObject({ kind: "attempt", attempt: 1 });
    expect(events.filter((e) => e.kind === "truncated")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "truncated", at: NOW, attempt: 1 });
    expect(events.some((e) => e.attempt === 2)).toBe(false);
  });

  it("never throws when the trace cannot be written and still closes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = new RunTraceWriter(
      path.join(dir, "no-such-dir", "trace.jsonl"),
      now,
    );
    writer.startAttempt(1);
    writer.consume(textLine);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writer.consume(textLine);
    writer.startAttempt(2);
    await expect(writer.close()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/^\[trace\] /);
  });

  it("keeps writing after a tool input too deeply nested to serialize", async () => {
    const file = path.join(dir, "trace.jsonl");
    const writer = new RunTraceWriter(file, now);
    writer.startAttempt(1);
    const depth = 10_000;
    const deep =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_deep",' +
      `"name":"mcp__x__y","input":{"a":${"[".repeat(depth)}${"]".repeat(depth)}}}]}}`;
    expect(() => writer.consume(deep)).not.toThrow();
    writer.consume(textLine);
    await writer.close();
    expect(readTrace(file).map((e) => e.kind)).toEqual([
      "attempt",
      "tool_use",
      "text",
    ]);
  });

  it("degrades to a no-op, logging once, when mapping or writing an event throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const opened = vi.spyOn(fs, "createWriteStream");
    const file = path.join(dir, "trace.jsonl");
    let clockBroken = false;
    const writer = new RunTraceWriter(file, () => {
      if (clockBroken) throw new Error("clock failed");
      return NOW;
    });
    writer.startAttempt(1);
    writer.consume(textLine);
    // textLine has no timestamp, so mapping it reads the clock.
    clockBroken = true;
    expect(() => writer.consume(textLine)).not.toThrow();
    clockBroken = false;
    writer.consume(textLine);
    writer.startAttempt(2);
    await writer.close();

    // What was written before the failure is kept, and the file is closed.
    expect(readTrace(file)).toEqual([
      { kind: "attempt", version: 1, attempt: 1, at: NOW },
      {
        kind: "text",
        at: NOW,
        attempt: 1,
        parent: null,
        messageId: null,
        text: "hi",
      },
    ]);
    expect((opened.mock.results[0].value as fs.WriteStream).closed).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/^\[trace\] .*clock failed/);

    // A throw while marking an attempt is contained the same way.
    const broken = new RunTraceWriter(path.join(dir, "other.jsonl"), () => {
      throw new Error("clock failed");
    });
    expect(() => broken.startAttempt(1)).not.toThrow();
    expect(() => broken.consume(textLine)).not.toThrow();
    await expect(broken.close()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("runJob trace capture", () => {
  let root: string;
  let job: JobConfig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-trace-run-"));
    job = {
      name: "Trace test",
      type: "claude",
      schedule: "0 0 * * *",
      directory: root,
      prompt: "test",
      enabled: false,
      tags: [],
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Puts a fake `claude` first on PATH that replays the fixture and exits with `exitCode`. */
  function fakeClaude(exitCode: number): void {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh\ncat '${FIXTURE}'\nexit ${exitCode}\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  }

  it("writes trace.jsonl for a Claude run without changing output.log", async () => {
    fakeClaude(0);
    const run = await runJob({
      jobId: "job",
      jobConfig: job,
      projectRoot: root,
      trigger: "manual",
    });
    expect(run.status).toBe("success");

    const events = readTrace(getTracePath(root, "job", run.runId));
    expect(events[0]).toMatchObject({
      kind: "attempt",
      attempt: 1,
      version: 1,
    });
    // Complete once runJob resolves: the final result is already on disk.
    expect(events.at(-1)).toMatchObject({
      kind: "result",
      attempt: 1,
      isError: false,
    });

    const uses = events.filter((e) => e.kind === "tool_use");
    const results = events.filter((e) => e.kind === "tool_result");
    expect(uses.map((e) => e.id)).toEqual([
      "toolu_012vLT7ck1s1QXRjcnkzBrkC",
      "toolu_016KQcunkzY7fyDtVcKFM1d4",
      "toolu_01HD4WjwjSVVQSDeToRRLodg",
      AGENT_ID,
      "toolu_01Qj6ppXnsX7YSXdUy8PiPyw",
      "toolu_01WGHmbh1Xtn9BTpFC4USMyR",
    ]);
    expect(results.map((e) => e.id).sort()).toEqual(
      uses.map((e) => e.id).sort(),
    );
    expect(
      results
        .filter((e) => e.isError)
        .map((e) => e.id)
        .sort(),
    ).toEqual([
      "toolu_01HD4WjwjSVVQSDeToRRLodg",
      "toolu_01WGHmbh1Xtn9BTpFC4USMyR",
    ]);

    const subagentActivity = events.filter(
      (e) => "parent" in e && e.parent === AGENT_ID,
    );
    expect(subagentActivity.map((e) => e.kind)).toEqual([
      "tool_use",
      "tool_result",
      "text",
    ]);
    expect(events.filter((e) => e.kind === "subagent")).toMatchObject([
      { toolUseId: AGENT_ID, status: "started" },
      { toolUseId: AGENT_ID, status: "completed" },
    ]);

    // Byte-for-byte what the runner writes without the trace wiring.
    const log = fs.readFileSync(getLogPath(root, "job", run.runId), "utf8");
    expect(log).toBe(fs.readFileSync(FIXTURE_LOG, "utf8"));
  });

  it("has flushed and closed the trace file by the time the run is finalized", async () => {
    fakeClaude(0);
    const opened = vi.spyOn(fs, "createWriteStream");
    const run = await runJob({
      jobId: "job",
      jobConfig: job,
      projectRoot: root,
      trigger: "manual",
    });
    const tracePath = getTracePath(root, "job", run.runId);
    const index = opened.mock.calls.findIndex(([file]) => file === tracePath);
    expect(index).toBeGreaterThanOrEqual(0);
    const stream = opened.mock.results[index].value as fs.WriteStream;
    expect(stream.writableFinished).toBe(true);
    expect(stream.closed).toBe(true);
  });

  it("appends every retry attempt to the same trace after its own marker", async () => {
    fakeClaude(1);
    const run = await runJob({
      jobId: "job",
      jobConfig: job,
      projectRoot: root,
      trigger: "manual",
      maxRetries: 1,
    });
    expect(run.status).toBe("failed");

    const events = readTrace(getTracePath(root, "job", run.runId));
    const markers = events.flatMap((e, i) => (e.kind === "attempt" ? [i] : []));
    expect(markers.map((i) => events[i].attempt)).toEqual([1, 2]);
    expect(markers[0]).toBe(0);
    const first = events.slice(0, markers[1]);
    const second = events.slice(markers[1]);
    expect(first.every((e) => e.attempt === 1)).toBe(true);
    expect(second.every((e) => e.attempt === 2)).toBe(true);
    // Both attempts replayed the same stream, so they captured the same events.
    expect(second.map((e) => e.kind)).toEqual(first.map((e) => e.kind));
    expect(second.at(-1)).toMatchObject({ kind: "result" });
  });

  it("writes no trace for script jobs or explicit command overrides", async () => {
    const script = await runJob({
      jobId: "job",
      jobConfig: {
        ...job,
        type: "script",
        command: "echo scripted",
        prompt: undefined,
      },
      projectRoot: root,
      trigger: "manual",
    });
    expect(script.status).toBe("success");
    expect(fs.existsSync(getTracePath(root, "job", script.runId))).toBe(false);

    // Even when the overriding command prints stream-json.
    const override = await runJob({
      jobId: "job",
      jobConfig: job,
      projectRoot: root,
      trigger: "manual",
      command: "sh",
      args: ["-c", `cat '${FIXTURE}'`],
    });
    expect(override.status).toBe("success");
    expect(fs.existsSync(getTracePath(root, "job", override.runId))).toBe(
      false,
    );
  });
});
