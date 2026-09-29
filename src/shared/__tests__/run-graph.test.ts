import { describe, it, expect } from "vitest";
import {
  buildGraphFromAgentLog,
  buildGraphFromScriptLog,
  buildGraphFromTrace,
  categorizeTool,
  parseTraceLines,
  type RunGraphContext,
} from "../run-graph";
import { TOOL_CATEGORIES } from "../run-graph-types";
import type {
  RunGraph,
  RunGraphCall,
  RunGraphLane,
  RunGraphStep,
} from "../run-graph-types";
import type { TraceEvent } from "../run-trace-types";

const ctx = (overrides: Partial<RunGraphContext> = {}): RunGraphContext => ({
  jobId: "job",
  runId: "run-1",
  kind: "agent",
  status: "success",
  exitCode: 0,
  startedAt: "2026-09-28T09:28:30.000Z",
  finishedAt: "2026-09-28T09:29:00.000Z",
  ...overrides,
});

// Small event factories. Times are seconds after 09:28:00.
const t = (seconds: number): string =>
  new Date(
    Date.UTC(2026, 8, 28, 9, 28, 0) + Math.round(seconds * 1000),
  ).toISOString();
const attemptEv = (at: number, attempt = 1): TraceEvent => ({
  kind: "attempt",
  at: t(at),
  attempt,
  version: 1,
});
const text = (
  at: number,
  messageId: string | null,
  body: string,
  parent: string | null = null,
  attempt = 1,
): TraceEvent => ({
  kind: "text",
  at: t(at),
  attempt,
  parent,
  messageId,
  text: body,
});
const use = (
  at: number,
  messageId: string | null,
  id: string,
  name: string,
  extra: {
    parent?: string | null;
    path?: string | null;
    summary?: string;
    agent?: { description: string | null; subagentType: string | null } | null;
    attempt?: number;
  } = {},
): TraceEvent => ({
  kind: "tool_use",
  at: t(at),
  attempt: extra.attempt ?? 1,
  parent: extra.parent ?? null,
  messageId,
  id,
  name,
  summary: extra.summary ?? "",
  path: extra.path ?? null,
  agent: extra.agent ?? null,
});
const result = (
  at: number,
  id: string,
  isError = false,
  parent: string | null = null,
  preview = "",
  attempt = 1,
): TraceEvent => ({
  kind: "tool_result",
  at: t(at),
  attempt,
  parent,
  id,
  isError,
  preview,
});
/** A tool_result that only acknowledges a background launch (async Agent, Bash run_in_background). */
const launchAck = (at: number, id: string, preview: string): TraceEvent => ({
  kind: "tool_result",
  at: t(at),
  attempt: 1,
  parent: null,
  id,
  isError: false,
  preview,
  launched: true,
});
const subagent = (
  at: number,
  toolUseId: string,
  status: string,
  extra: { summary?: string; toolUses?: number; durationMs?: number } = {},
): TraceEvent => ({
  kind: "subagent",
  at: t(at),
  attempt: 1,
  toolUseId,
  status,
  summary: extra.summary ?? null,
  toolUses: extra.toolUses ?? null,
  durationMs: extra.durationMs ?? null,
});
const runResult = (
  at: number,
  isError: boolean,
  body: string | null = null,
  attempt = 1,
): TraceEvent => ({
  kind: "result",
  at: t(at),
  attempt,
  isError,
  subtype: isError ? "error_during_execution" : "success",
  durationMs: 1000,
  numTurns: 2,
  costUsd: 0.01,
  permissionDenials: 0,
  text: body,
});

function mainLane(graph: RunGraph, attemptIndex = 0): RunGraphLane {
  const lane = graph.attempts[attemptIndex].lane;
  if (!lane) throw new Error("expected an agent lane");
  return lane;
}

function allSteps(graph: RunGraph): RunGraphStep[] {
  const steps: RunGraphStep[] = [];
  const visit = (lane: RunGraphLane): void => {
    for (const step of lane.steps) {
      steps.push(step);
      for (const call of step.calls) if (call.subagent) visit(call.subagent);
    }
  };
  for (const attempt of graph.attempts) if (attempt.lane) visit(attempt.lane);
  return steps;
}

function allLaneIds(graph: RunGraph): string[] {
  const ids: string[] = [];
  const visit = (lane: RunGraphLane, depth: number): void => {
    if (depth > 20) throw new Error("lane nesting loops");
    ids.push(lane.id);
    for (const step of lane.steps)
      for (const call of step.calls)
        if (call.subagent) visit(call.subagent, depth + 1);
  };
  for (const attempt of graph.attempts)
    if (attempt.lane) visit(attempt.lane, 0);
  return ids;
}

const zeroCategories = Object.fromEntries(
  TOOL_CATEGORIES.map((category) => [category, 0]),
);

describe("categorizeTool", () => {
  it.each([
    ["Read", "read"],
    ["NotebookRead", "read"],
    ["LS", "read"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["ToolSearch", "search"],
    ["LSP", "search"],
    ["Write", "edit"],
    ["Edit", "edit"],
    ["MultiEdit", "edit"],
    ["NotebookEdit", "edit"],
    ["Bash", "shell"],
    ["BashOutput", "shell"],
    ["KillShell", "shell"],
    ["KillBash", "shell"],
    ["Monitor", "shell"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Agent", "agent"],
    ["Task", "agent"],
    ["SendMessage", "agent"],
    ["Skill", "skill"],
    ["SlashCommand", "skill"],
    ["TodoWrite", "plan"],
    ["TaskCreate", "plan"],
    ["TaskUpdate", "plan"],
    ["TaskList", "plan"],
    ["TaskGet", "plan"],
    ["TaskStop", "plan"],
    ["EnterPlanMode", "plan"],
    ["ExitPlanMode", "plan"],
    ["AskUserQuestion", "plan"],
    ["ScheduleWakeup", "plan"],
  ])("puts %s in %s with its own name as label", (name, category) => {
    expect(categorizeTool(name)).toEqual({
      category,
      label: name,
      server: null,
    });
  });

  it.each([
    ["mcp__atlassian__jira_get_issue", "atlassian", "jira_get_issue"],
    ["mcp__claude-in-chrome__navigate", "claude-in-chrome", "navigate"],
    [
      "mcp__es-prod-us-central1-mcp__search",
      "es-prod-us-central1-mcp",
      "search",
    ],
    [
      "mcp__claude_ai_Google_Calendar__list_events",
      "claude_ai_Google_Calendar",
      "list_events",
    ],
    [
      "mcp__plugin_context7_context7__query-docs",
      "plugin_context7_context7",
      "query-docs",
    ],
  ])("splits MCP tool %s into server %s and tool %s", (name, server, label) => {
    expect(categorizeTool(name)).toEqual({ category: "mcp", label, server });
  });

  it("files unknown tools, incomplete MCP names and prototype keys under other", () => {
    for (const name of [
      "ReportFindings",
      "TaskOutput",
      "mcp__atlassian",
      "mcp__atlassian__",
      "constructor",
      "toString",
    ]) {
      expect(categorizeTool(name)).toEqual({
        category: "other",
        label: name,
        server: null,
      });
    }
  });
});

describe("parseTraceLines", () => {
  it("keeps valid events and skips blank, unparsable, partial and structurally invalid lines", () => {
    const lines = [
      JSON.stringify({
        kind: "attempt",
        at: "2026-09-28T09:00:00.000Z",
        attempt: 1,
        version: 1,
      }),
      "",
      "   ",
      "not json",
      JSON.stringify([1, 2]),
      JSON.stringify({
        kind: "bogus",
        at: "2026-09-28T09:00:00.000Z",
        attempt: 1,
      }),
      JSON.stringify({
        kind: "tool_use",
        at: "2026-09-28T09:00:01.000Z",
        attempt: 1,
        parent: null,
        messageId: "m",
        name: "Bash",
        summary: "",
      }),
      JSON.stringify({
        kind: "text",
        at: "2026-09-28T09:00:01.000Z",
        attempt: "1",
        parent: null,
        messageId: "m",
        text: "attempt as string",
      }),
      JSON.stringify({
        kind: "text",
        at: "2026-09-28T09:00:01.000Z",
        attempt: 0,
        parent: null,
        messageId: "m",
        text: "attempt zero",
      }),
      JSON.stringify({
        kind: "text",
        at: "2026-09-28T09:00:01.000Z",
        attempt: 1,
        parent: 7,
        messageId: "m",
        text: "numeric parent",
      }),
      JSON.stringify({
        kind: "tool_result",
        at: "2026-09-28T09:00:01.000Z",
        attempt: 1,
        parent: null,
        id: "x",
        isError: "no",
        preview: "",
      }),
      JSON.stringify({
        kind: "text",
        at: "2026-09-28T09:00:02.000Z",
        attempt: 1,
        parent: null,
        messageId: "m",
        text: "hi",
        junk: true,
      }),
      '{"kind":"tool_use","at":"2026-09-28T09:00:03.000Z","attempt":1,"parent":null,"mess',
    ].join("\n");

    expect(parseTraceLines(lines)).toEqual([
      {
        kind: "attempt",
        at: "2026-09-28T09:00:00.000Z",
        attempt: 1,
        version: 1,
      },
      {
        kind: "text",
        at: "2026-09-28T09:00:02.000Z",
        attempt: 1,
        parent: null,
        messageId: "m",
        text: "hi",
      },
    ]);
  });

  it("reads absent nullable fields as null", () => {
    const [session, use] = parseTraceLines(
      [
        JSON.stringify({
          kind: "session",
          at: "2026-09-28T09:00:00.000Z",
          attempt: 1,
        }),
        JSON.stringify({
          kind: "tool_use",
          at: "2026-09-28T09:00:01.000Z",
          attempt: 1,
          id: "toolu_1",
          name: "Read",
          summary: "a.ts",
        }),
      ].join("\n"),
    );
    expect(session).toEqual({
      kind: "session",
      at: "2026-09-28T09:00:00.000Z",
      attempt: 1,
      model: null,
      cliVersion: null,
    });
    expect(use).toEqual({
      kind: "tool_use",
      at: "2026-09-28T09:00:01.000Z",
      attempt: 1,
      parent: null,
      messageId: null,
      id: "toolu_1",
      name: "Read",
      summary: "a.ts",
      path: null,
      agent: null,
    });
  });

  it("keeps a tool_result's launched flag, and leaves it out of older traces", () => {
    const [launched, plain] = parseTraceLines(
      [
        JSON.stringify({
          kind: "tool_result",
          at: "2026-09-28T09:00:01.000Z",
          attempt: 1,
          parent: null,
          id: "toolu_agent",
          isError: false,
          preview: "Async agent launched successfully.",
          launched: true,
        }),
        JSON.stringify({
          kind: "tool_result",
          at: "2026-09-28T09:00:02.000Z",
          attempt: 1,
          parent: null,
          id: "toolu_read",
          isError: false,
          preview: "1\thello",
        }),
      ].join("\n"),
    );
    expect(launched).toEqual({
      kind: "tool_result",
      at: "2026-09-28T09:00:01.000Z",
      attempt: 1,
      parent: null,
      id: "toolu_agent",
      isError: false,
      preview: "Async agent launched successfully.",
      launched: true,
    });
    expect(plain).not.toHaveProperty("launched");
    // A status flag with the wrong type drops the line, like isError.
    expect(
      parseTraceLines(
        JSON.stringify({
          kind: "tool_result",
          at: "2026-09-28T09:00:01.000Z",
          attempt: 1,
          parent: null,
          id: "toolu_agent",
          isError: false,
          preview: "",
          launched: "yes",
        }),
      ),
    ).toEqual([]);
  });
});

describe("buildGraphFromTrace", () => {
  // The run in the real stream-json capture (Claude Code 2.1.283): Glob, two
  // Reads (one missing file), a background Agent that reads b.txt, a Read of
  // the agent's oversized output file, then the final answer.
  const AGENT = "toolu_01BBAo2NqZw2Gdd88QFCYUsW";
  const DIR = "/private/tmp/sample";
  const sampleEvents: TraceEvent[] = [
    attemptEv(30),
    {
      kind: "session",
      at: t(33),
      attempt: 1,
      model: "claude-haiku-4-5-20251001",
      cliVersion: "2.1.283",
    },
    text(36.623, "msg_BK", "I'll work through these steps in sequence."),
    use(36.853, "msg_BK", "toolu_glob", "Glob", { summary: "*.txt" }),
    result(36.961, "toolu_glob", false, null, "a.txt\nb.txt\nstderr.txt"),
    use(39.11, "msg_AX", "toolu_read_a", "Read", {
      path: `${DIR}/a.txt`,
      summary: `${DIR}/a.txt`,
    }),
    result(39.243, "toolu_read_a", false, null, "1\thello"),
    use(40.938, "msg_NJ", "toolu_read_missing", "Read", {
      path: `${DIR}/missing.txt`,
    }),
    result(40.943, "toolu_read_missing", true, null, "File does not exist."),
    use(43.355, "msg_DP", AGENT, "Agent", {
      summary: "count words",
      agent: { description: "count words", subagentType: "general-purpose" },
    }),
    subagent(43.4, AGENT, "started"),
    result(43.478, AGENT, false, null, "Async agent launched successfully."),
    use(45.606, "msg_Esd", "toolu_read_b", "Read", {
      parent: AGENT,
      path: `${DIR}/b.txt`,
    }),
    result(45.765, "toolu_read_b", false, AGENT, "1\tworld"),
    text(
      47.016,
      "msg_MP",
      'The file `b.txt` contains **1 word**: "world"',
      AGENT,
    ),
    subagent(47.1, AGENT, "completed", {
      summary: 'The file `b.txt` contains **1 word**: "world"',
      toolUses: 1,
      durationMs: 3681,
    }),
    text(47.996, "msg_zhE", "I've started steps 1-3."),
    use(49.415, "msg_zhE", "toolu_read_out", "Read", {
      path: "/tmp/tasks/a92e65402cfc69e1a.output",
    }),
    result(
      49.422,
      "toolu_read_out",
      true,
      null,
      "File content (298.4KB) exceeds maximum allowed size (256KB).",
    ),
    text(51.539, "msg_tUU1", "All five steps completed."),
    {
      kind: "result",
      at: t(52),
      attempt: 1,
      isError: false,
      subtype: "success",
      durationMs: 22541,
      numTurns: 6,
      costUsd: 0.18102884999999996,
      permissionDenials: 0,
      text: "All five steps completed.",
    },
  ];

  it("turns the real sample into one step per assistant message with call outcomes and timings", () => {
    const graph = buildGraphFromTrace(sampleEvents, ctx());
    expect(graph.source).toBe("trace");
    expect(graph.attempts).toHaveLength(1);
    const attempt = graph.attempts[0];
    expect(attempt.startedAt).toBe(t(30));
    expect(attempt.model).toBe("claude-haiku-4-5-20251001");
    expect(attempt.outcome).toEqual({
      isError: false,
      subtype: "success",
      durationMs: 22541,
      numTurns: 6,
      costUsd: 0.18102884999999996,
      permissionDenials: 0,
      text: "All five steps completed.",
    });

    const main = mainLane(graph);
    expect(main).toMatchObject({
      id: "main",
      label: "Main agent",
      status: "ok",
      summary: "All five steps completed.",
    });
    expect(
      main.steps.map((step) => [
        step.narration,
        step.calls.map((call) => call.id),
      ]),
    ).toEqual([
      ["I'll work through these steps in sequence.", ["toolu_glob"]],
      [null, ["toolu_read_a"]],
      [null, ["toolu_read_missing"]],
      [null, [AGENT]],
      ["I've started steps 1-3.", ["toolu_read_out"]],
      ["All five steps completed.", []],
    ]);
    expect(main.steps[0].startedAt).toBe(t(36.623));

    const [glob] = main.steps[0].calls;
    expect(glob).toMatchObject({
      name: "Glob",
      label: "Glob",
      category: "search",
      summary: "*.txt",
      status: "ok",
      durationMs: 108,
      resultPreview: "a.txt\nb.txt\nstderr.txt",
    });
    expect(main.steps[1].calls[0]).toMatchObject({
      status: "ok",
      durationMs: 133,
    });
    expect(main.steps[2].calls[0]).toMatchObject({
      status: "error",
      durationMs: 5,
      resultPreview: "File does not exist.",
    });
    expect(main.steps[4].calls[0]).toMatchObject({
      status: "error",
      durationMs: 7,
    });
  });

  it("lets the async agent's completion notification override its immediate tool_result", () => {
    const main = mainLane(buildGraphFromTrace(sampleEvents, ctx()));
    const agentCall = main.steps[3].calls[0];
    // The tool_result came back 123 ms after launch; the agent really ran 3681 ms.
    expect(agentCall).toMatchObject({
      category: "agent",
      status: "ok",
      durationMs: 3681,
    });
    const lane = agentCall.subagent as RunGraphLane;
    expect(lane).toMatchObject({
      id: AGENT,
      label: "count words",
      subagentType: "general-purpose",
      status: "ok",
      summary: 'The file `b.txt` contains **1 word**: "world"',
      toolUses: 1,
      durationMs: 3681,
    });
    expect(
      lane.steps.map((step) => [
        step.narration,
        step.calls.map((call) => call.id),
      ]),
    ).toEqual([
      [null, ["toolu_read_b"]],
      ['The file `b.txt` contains **1 word**: "world"', []],
    ]);
    expect(lane.steps[0].calls[0]).toMatchObject({
      status: "ok",
      durationMs: 159,
    });

    const failed = sampleEvents.map((event) =>
      event.kind === "subagent" && event.status === "completed"
        ? { ...event, status: "failed" }
        : event,
    );
    const failedMain = mainLane(buildGraphFromTrace(failed, ctx()));
    expect(failedMain.steps[3].calls[0].status).toBe("error");
    expect(failedMain.steps[3].calls[0].subagent?.status).toBe("error");
  });

  it("settles a background Bash call from its task notification without inventing a subagent", () => {
    // Order captured from Claude Code 2.1.283 for `Bash` with run_in_background: the
    // task lifecycle (task_type "local_bash") is streamed before the call's own
    // "running in background" tool_result.
    const events = (status: string, summary: string): TraceEvent[] => [
      attemptEv(0),
      use(1, "m1", "toolu_bg", "Bash", {
        summary: "$ sleep 3 && echo bg-done",
      }),
      subagent(1.1, "toolu_bg", "started"),
      subagent(4.2, "toolu_bg", status, { summary }),
      result(
        4.3,
        "toolu_bg",
        false,
        null,
        "Command running in background with ID: bynttn75p.",
      ),
      runResult(6, false, "bg-done"),
    ];

    const done = buildGraphFromTrace(
      events(
        "completed",
        'Background command "Run background task with sleep" completed (exit code 0)',
      ),
      ctx(),
    );
    const call = mainLane(done).steps[0].calls[0];
    expect(call).toMatchObject({
      category: "shell",
      status: "ok",
      subagent: null,
      resultPreview:
        'Background command "Run background task with sleep" completed (exit code 0)',
    });
    expect(done.totals.subagents).toBe(0);
    expect(allLaneIds(done)).toEqual(["main"]);

    const failed = buildGraphFromTrace(
      events("failed", "Background command failed (exit code 1)"),
      ctx(),
    );
    expect(mainLane(failed).steps[0].calls[0]).toMatchObject({
      status: "error",
      subagent: null,
    });
    expect(failed.totals.errors).toBe(1);
  });

  describe("an attempt with several CLI results", () => {
    // Real run diagram-demo/2026-09-28T10-18-48-66a0f1 (Claude Code 2.1.283): the
    // main turn ended while an async Agent was still running, so the CLI emitted a
    // result, a second init, a follow-up turn and a second result. duration_ms,
    // num_turns and permission_denials cover one query each; total_cost_usd is
    // cumulative (costs.json holds the second value).
    const firstText =
      "The Bash command requires approval. I'm waiting for the Agent to complete.";
    const lastText =
      'Found "hello" in a.txt (1 word), b.txt has "world" (1 word), and missing.txt does not exist (as expected).';
    const session = (at: number): TraceEvent => ({
      kind: "session",
      at: t(at),
      attempt: 1,
      model: "claude-haiku-4-5-20251001",
      cliVersion: "2.1.283",
    });
    const mainTurn: TraceEvent[] = [
      attemptEv(0),
      session(4.09),
      use(15.241, "m1", "bash_ls", "Bash", { summary: "$ ls *.txt" }),
      result(
        15.658,
        "bash_ls",
        true,
        null,
        "This Bash command contains multiple operations. The following part requires approval: rtk ls *.txt",
      ),
      use(22.128, "m2", "bash_grep", "Bash", { summary: '$ grep -l "hello"' }),
      result(22.362, "bash_grep", true, null, "This command requires approval"),
      text(26.528, "m3", firstText),
      {
        kind: "result",
        at: t(31.63),
        attempt: 1,
        isError: false,
        subtype: "success",
        durationMs: 27739,
        numTurns: 7,
        costUsd: 0.14380734999999997,
        permissionDenials: 2,
        text: firstText,
      },
    ];
    const continuation: TraceEvent[] = [
      session(31.78),
      text(37.468, "m4", lastText),
      {
        kind: "result",
        at: t(42.52),
        attempt: 1,
        isError: false,
        subtype: "success",
        durationMs: 10886,
        numTurns: 1,
        costUsd: 0.15281314999999998,
        permissionDenials: 0,
        text: lastText,
      },
    ];

    it("adds up turns, time and denials, and takes cost and text from the last result", () => {
      const graph = buildGraphFromTrace([...mainTurn, ...continuation], ctx());
      // 8 turns, 27.7 s + 10.9 s of CLI time and the 2 denied Bash calls.
      const outcome = {
        isError: false,
        subtype: "success",
        durationMs: 38625,
        numTurns: 8,
        costUsd: 0.15281314999999998,
        permissionDenials: 2,
        text: lastText,
      };
      expect(graph.attempts[0].outcome).toEqual(outcome);
      expect(mainLane(graph)).toMatchObject({
        status: "ok",
        durationMs: 38625,
        summary: lastText,
      });
    });

    it("keeps the main lane running while the live run continues past a result", () => {
      const live = ctx({ status: "running", exitCode: null, finishedAt: null });
      const afterFirst = mainLane(
        buildGraphFromTrace([...mainTurn, continuation[0]], live),
      );
      expect(afterFirst.status).toBe("running");
      const afterLast = mainLane(
        buildGraphFromTrace([...mainTurn, ...continuation], live),
      );
      expect(afterLast.status).toBe("running");
    });

    it("sums only the counts a result reported, and keeps a count no result reported unknown", () => {
      const partial = (
        at: number,
        durationMs: number | null,
        numTurns: number | null,
      ): TraceEvent => ({
        kind: "result",
        at: t(at),
        attempt: 1,
        isError: at > 5,
        subtype: at > 5 ? "error_during_execution" : "success",
        durationMs,
        numTurns,
        costUsd: null,
        permissionDenials: 1,
        text: null,
      });
      const graph = buildGraphFromTrace(
        [attemptEv(0), partial(1, null, 3), partial(6, 4000, null)],
        ctx({ status: "failed", exitCode: 1 }),
      );
      expect(graph.attempts[0].outcome).toEqual({
        isError: true,
        subtype: "error_during_execution",
        durationMs: 4000,
        numTurns: 3,
        costUsd: null,
        permissionDenials: 2,
        text: null,
      });
      expect(mainLane(graph).status).toBe("error");
      const unknown = buildGraphFromTrace(
        [attemptEv(0), partial(1, null, null), partial(2, null, null)],
        ctx(),
      ).attempts[0].outcome;
      expect(unknown).toMatchObject({ durationMs: null, numTurns: null });
    });
  });

  describe("a call whose tool_result only acknowledges a background launch", () => {
    // Order and times from the real run diagram-demo/2026-09-28T10-18-48-66a0f1:
    // tool_use 10:19:08.008, task_started .022, the "Async agent launched" tool_result
    // .128, and the completion notification at 10:19:12.929 reporting 4911 ms.
    const AG = "toolu_014j1ieT2wBFKDmja8mAngro";
    const ACK = "Async agent launched successfully.";
    const launched: TraceEvent[] = [
      attemptEv(0),
      use(8.008, "m1", AG, "Agent", {
        summary: "count words",
        agent: { description: "count words", subagentType: "general-purpose" },
      }),
      subagent(8.022, AG, "started"),
      launchAck(8.128, AG, ACK),
    ];

    it("keeps an async subagent's call pending, without the acknowledgement's latency, until it reports", () => {
      const live = mainLane(
        buildGraphFromTrace(
          launched,
          ctx({ status: "running", exitCode: null, finishedAt: null }),
        ),
      ).steps[0].calls[0];
      expect(live).toMatchObject({
        status: "pending",
        durationMs: null,
        resultPreview: ACK,
      });
      expect(live.subagent?.status).toBe("running");

      // The run ended (here: timed out) before the subagent reported back.
      const ended = mainLane(
        buildGraphFromTrace(
          launched,
          ctx({ status: "timeout", exitCode: null }),
        ),
      ).steps[0].calls[0];
      expect(ended).toMatchObject({ status: "pending", durationMs: null });
      expect(ended.subagent?.status).toBe("stopped");

      const done = mainLane(
        buildGraphFromTrace(
          [
            ...launched,
            subagent(12.929, AG, "completed", {
              summary: "b.txt contains 1 word",
              toolUses: 1,
              durationMs: 4911,
            }),
            runResult(20, false),
          ],
          ctx(),
        ),
      ).steps[0].calls[0];
      expect(done).toMatchObject({
        status: "ok",
        durationMs: 4911,
        resultPreview: ACK,
      });
      expect(done.subagent).toMatchObject({
        status: "ok",
        summary: "b.txt contains 1 word",
      });
    });

    it("settles a launched subagent from its terminal notification", () => {
      const ending = (status: string, durationMs?: number) =>
        mainLane(
          buildGraphFromTrace(
            [
              ...launched,
              subagent(28.008, AG, status, { durationMs }),
              runResult(30, false),
            ],
            ctx(),
          ),
        ).steps[0].calls[0];
      expect(ending("failed", 5000)).toMatchObject({
        status: "error",
        durationMs: 5000,
      });
      // No duration in the notification: timed from the call to the notification.
      const killed = ending("killed");
      expect(killed).toMatchObject({ status: "unknown", durationMs: 20000 });
      expect(killed.subagent?.status).toBe("stopped");
      for (const stopped of ["stopped", "cancelled", "canceled"])
        expect(ending(stopped).status).toBe("unknown");
    });

    it("times a background Bash call from its launch to its notification, whose summary becomes the result", () => {
      const background = (
        notification: TraceEvent[],
        run = ctx(),
      ): RunGraphCall =>
        mainLane(
          buildGraphFromTrace(
            [
              attemptEv(0),
              use(1, "m1", "bg", "Bash", { summary: "$ npm run e2e" }),
              subagent(1.1, "bg", "started"),
              launchAck(1.2, "bg", "Command running in background with ID: x"),
              ...notification,
            ],
            run,
          ),
        ).steps[0].calls[0];
      const completed = 'Background command "e2e" completed (exit code 0)';
      expect(
        background([subagent(301, "bg", "completed", { summary: completed })]),
      ).toMatchObject({
        status: "ok",
        durationMs: 300000,
        resultPreview: completed,
        subagent: null,
      });
      const stopped = 'Background command "e2e" was stopped';
      expect(
        background([subagent(301, "bg", "stopped", { summary: stopped })]),
      ).toMatchObject({
        status: "unknown",
        durationMs: 300000,
        resultPreview: stopped,
      });
      expect(
        background([subagent(301, "bg", "failed", { summary: "exit code 1" })])
          .status,
      ).toBe("error");
      // Still running in a live run: the launch said nothing about the outcome.
      expect(
        background(
          [],
          ctx({ status: "running", exitCode: null, finishedAt: null }),
        ),
      ).toMatchObject({
        status: "pending",
        durationMs: null,
        resultPreview: "Command running in background with ID: x",
      });
    });

    it("settles a background Bash call whose notification was streamed before its launch acknowledgement", () => {
      // The order in the real capture sample/stream-bg.jsonl (task_notification on
      // line 70, the tool_result with backgroundTaskId on line 71).
      const summary =
        'Background command "Run background task with sleep" completed (exit code 0)';
      const graph = buildGraphFromTrace(
        [
          attemptEv(0),
          use(1, "m1", "bg", "Bash", { summary: "$ sleep 3 && echo bg-done" }),
          subagent(1.1, "bg", "started"),
          subagent(4.2, "bg", "completed", { summary }),
          launchAck(
            4.3,
            "bg",
            "Command running in background with ID: bynttn75p.",
          ),
          runResult(6, false),
        ],
        ctx(),
      );
      expect(mainLane(graph).steps[0].calls[0]).toMatchObject({
        status: "ok",
        durationMs: 3200,
        resultPreview: summary,
      });
    });
  });

  it("leaves an edit that failed or was denied out of the changed files", () => {
    const graph = buildGraphFromTrace(
      [
        use(1, "m1", "w1", "Write", { path: "/r/report.md" }),
        result(
          2,
          "w1",
          true,
          null,
          "File has not been read yet. Read it first before writing to it.",
        ),
        use(3, "m2", "e1", "Edit", { path: "/r/denied.ts" }),
        result(4, "e1", true, null, "This command requires approval"),
        use(5, "m3", "e2", "Edit", { path: "/r/a.ts" }),
        result(6, "e2", false, null, "The file /r/a.ts has been updated."),
        use(7, "m4", "r1", "Read", { path: "/r/report.md" }),
        result(8, "r1", false),
        use(9, "m5", "w2", "Write", { path: "/r/report.md" }),
        result(10, "w2", false),
        // Still running: it may yet change the file.
        use(11, "m6", "e3", "Edit", { path: "/r/b.ts" }),
      ],
      ctx({ status: "running", exitCode: null, finishedAt: null }),
    );
    expect(graph.totals.filesChanged).toEqual([
      "/r/a.ts",
      "/r/report.md",
      "/r/b.ts",
    ]);
    expect(graph.totals.errors).toBe(2);
  });

  it("totals every call across lanes, with zero-filled categories and unique file lists", () => {
    const graph = buildGraphFromTrace(sampleEvents, ctx());
    expect(graph.totals).toEqual({
      toolCalls: 6,
      errors: 2,
      subagents: 1,
      steps: 8,
      byCategory: { ...zeroCategories, read: 4, search: 1, agent: 1 },
      filesRead: [
        `${DIR}/a.txt`,
        `${DIR}/missing.txt`,
        `${DIR}/b.txt`,
        "/tmp/tasks/a92e65402cfc69e1a.output",
      ],
      filesChanged: [],
    });
    expect(Object.keys(graph.totals.byCategory).sort()).toEqual(
      [...TOOL_CATEGORIES].sort(),
    );
    const ids = allSteps(graph).map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.notes).toEqual([]);
  });

  it("collects changed files in first-seen order without duplicates", () => {
    const graph = buildGraphFromTrace(
      [
        use(1, "m1", "e1", "Edit", { path: "/r/a.ts" }),
        use(2, "m1", "w1", "Write", { path: "/r/b.ts" }),
        use(3, "m2", "e2", "MultiEdit", { path: "/r/a.ts" }),
        use(4, "m2", "r1", "Read", { path: "/r/b.ts" }),
        runResult(5, false),
      ],
      ctx(),
    );
    expect(graph.totals.filesChanged).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(graph.totals.filesRead).toEqual(["/r/b.ts"]);
    expect(graph.totals.byCategory).toEqual({
      ...zeroCategories,
      edit: 3,
      read: 1,
    });
  });

  it("starts steps by message id, and handles events without one", () => {
    const main = mainLane(
      buildGraphFromTrace(
        [
          text(1, "m1", "first"),
          text(2, "m1", "second"),
          use(3, "m1", "a", "Bash"),
          text(4, null, "no id"),
          use(5, null, "b", "Bash"),
          text(6, null, "another"),
          use(7, "m2", "c", "Bash"),
          use(8, "m2", "d", "Bash"),
          runResult(9, false),
        ],
        ctx(),
      ),
    );
    expect(
      main.steps.map((step) => [
        step.narration,
        step.calls.map((call) => call.id),
      ]),
    ).toEqual([
      ["first\nsecond", ["a"]],
      ["no id", ["b"]],
      ["another", []],
      [null, ["c", "d"]],
    ]);

    const orphanUse = mainLane(
      buildGraphFromTrace(
        [use(1, null, "x", "Read"), runResult(2, false)],
        ctx(),
      ),
    );
    expect(orphanUse.steps).toHaveLength(1);
    expect(orphanUse.steps[0].calls[0].id).toBe("x");
  });

  it("ignores a tool_result that answers no captured call", () => {
    const graph = buildGraphFromTrace(
      [use(1, "m1", "a", "Bash"), result(2, "zzz", true), runResult(3, false)],
      ctx(),
    );
    expect(graph.totals.toolCalls).toBe(1);
    expect(graph.totals.errors).toBe(0);
    expect(mainLane(graph).steps[0].calls[0].status).toBe("pending");
  });

  it("nests a subagent spawned by a subagent inside the call that spawned it", () => {
    const graph = buildGraphFromTrace(
      [
        use(1, "m1", "A", "Agent", {
          agent: {
            description: "outer review",
            subagentType: "general-purpose",
          },
        }),
        use(2, "s1", "B", "Task", {
          parent: "A",
          agent: { description: null, subagentType: "Explore" },
        }),
        use(3, "t1", "g", "Grep", { parent: "B", summary: "TODO" }),
        result(4, "g", false, "B"),
        result(5, "B", false, "A"),
        result(6, "A", false),
        runResult(7, false),
      ],
      ctx(),
    );
    const outer = mainLane(graph).steps[0].calls[0].subagent as RunGraphLane;
    expect(outer).toMatchObject({
      id: "A",
      label: "outer review",
      subagentType: "general-purpose",
      status: "ok",
    });
    const inner = outer.steps[0].calls[0].subagent as RunGraphLane;
    expect(inner).toMatchObject({
      id: "B",
      label: "Explore",
      subagentType: "Explore",
      status: "ok",
    });
    expect(inner.steps[0].calls[0]).toMatchObject({
      name: "Grep",
      summary: "TODO",
      status: "ok",
    });
    expect(graph.totals).toMatchObject({
      toolCalls: 3,
      subagents: 2,
      steps: 3,
    });
  });

  it("derives a sync subagent's status from its spawning call when no lifecycle was captured", () => {
    const events = (isError: boolean): TraceEvent[] => [
      use(1, "m1", "A", "Agent", {
        agent: { description: "", subagentType: null },
      }),
      use(2, "s1", "r", "Read", { parent: "A" }),
      result(3, "r", false, "A"),
      result(4, "A", isError),
      runResult(5, false),
    ];
    const ok = mainLane(buildGraphFromTrace(events(false), ctx())).steps[0]
      .calls[0].subagent;
    expect(ok).toMatchObject({
      label: "Subagent",
      subagentType: null,
      status: "ok",
    });
    const failed = mainLane(buildGraphFromTrace(events(true), ctx())).steps[0]
      .calls[0];
    expect(failed.status).toBe("error");
    expect(failed.subagent?.status).toBe("error");
  });

  it("maps subagent lifecycle statuses", () => {
    const laneStatus = (status: string, run = ctx()): string | undefined => {
      const graph = buildGraphFromTrace(
        [
          use(1, "m1", "A", "Agent"),
          subagent(2, "A", "started"),
          ...(status === "started" ? [] : [subagent(3, "A", status)]),
          runResult(4, false),
        ],
        run,
      );
      return mainLane(graph).steps[0].calls[0].subagent?.status;
    };
    expect(laneStatus("completed")).toBe("ok");
    expect(laneStatus("failed")).toBe("error");
    expect(laneStatus("error")).toBe("error");
    for (const stopped of ["killed", "stopped", "cancelled", "canceled"])
      expect(laneStatus(stopped)).toBe("stopped");
    expect(laneStatus("something-new")).toBe("unknown");
    expect(
      laneStatus("started", ctx({ status: "running", finishedAt: null })),
    ).toBe("running");
    // Started but never finished in a run that has ended: it did not keep running.
    expect(laneStatus("started")).toBe("stopped");
  });

  it("keeps a subagent whose spawn was not captured, under a synthetic Agent call", () => {
    const graph = buildGraphFromTrace(
      [
        text(1, "m1", "before"),
        use(3, "s1", "r", "Read", { parent: "lost", path: "/r/x.ts" }),
        result(4, "r", false, "lost"),
        text(5, "m2", "after"),
        runResult(6, false),
      ],
      ctx(),
    );
    const main = mainLane(graph);
    expect(
      main.steps.map((step) => step.narration ?? step.calls[0]?.summary),
    ).toEqual(["before", "Subagent (spawn not captured)", "after"]);
    const synthetic = main.steps[1].calls[0];
    expect(synthetic).toMatchObject({
      name: "Agent",
      category: "agent",
      status: "unknown",
    });
    expect(synthetic.subagent).toMatchObject({ id: "lost", label: "Subagent" });
    expect(synthetic.subagent?.steps[0].calls[0].path).toBe("/r/x.ts");
    expect(graph.totals.filesRead).toEqual(["/r/x.ts"]);
    expect(graph.totals.subagents).toBe(1);
  });

  it("attaches an uncaptured spawn to the lane that reported its result", () => {
    const graph = buildGraphFromTrace(
      [
        use(1, "m1", "A", "Agent", {
          agent: { description: "outer", subagentType: null },
        }),
        use(2, "s1", "q", "Bash", { parent: "A" }),
        use(3, "t1", "r", "Read", { parent: "lost" }),
        result(4, "lost", false, "A"),
        result(5, "A", false),
        runResult(6, false),
      ],
      ctx(),
    );
    const outer = mainLane(graph).steps[0].calls[0].subagent as RunGraphLane;
    const outerCalls = outer.steps.flatMap((step) => step.calls);
    const synthetic = outerCalls.find(
      (call) => call.subagent?.id === "lost",
    ) as RunGraphCall;
    expect(synthetic.summary).toBe("Subagent (spawn not captured)");
    expect(mainLane(graph).steps).toHaveLength(1);
  });

  it("never loops when malformed parents make lanes contain each other", () => {
    const graph = buildGraphFromTrace(
      [
        use(1, "m1", "X", "Agent", { parent: "Y" }),
        use(2, "m2", "Y", "Agent", { parent: "X" }),
        use(3, "m3", "Z", "Agent", { parent: "Z" }),
        runResult(4, false),
      ],
      ctx(),
    );
    expect(() => JSON.stringify(graph)).not.toThrow();
    expect(allLaneIds(graph).sort()).toEqual(["X", "Y", "Z", "main"]);
    expect(graph.totals.subagents).toBe(3);
  });

  it("builds one attempt per retry, in attempt order", () => {
    const graph = buildGraphFromTrace(
      [
        attemptEv(1, 1),
        use(2, "m1", "a", "Bash", { attempt: 1 }),
        result(3, "a", true, null, "", 1),
        runResult(4, true, "failed", 1),
        attemptEv(10, 2),
        use(11, "m1", "b", "Bash", { attempt: 2 }),
        result(12, "b", false, null, "", 2),
        runResult(13, false, "done", 2),
      ],
      ctx(),
    );
    expect(
      graph.attempts.map((attempt) => [
        attempt.attempt,
        attempt.startedAt,
        attempt.lane?.status,
        attempt.outcome?.text,
      ]),
    ).toEqual([
      [1, t(1), "error", "failed"],
      [2, t(10), "ok", "done"],
    ]);
    expect(graph.totals).toMatchObject({ toolCalls: 2, errors: 1, steps: 2 });
    const ids = allSteps(graph).map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows a live run as running with pending calls, and an ended one as stopped", () => {
    const events: TraceEvent[] = [
      attemptEv(1, 1),
      use(2, "m1", "a", "Bash", { attempt: 1 }),
      attemptEv(10, 2),
      use(11, "m1", "S", "Agent", { attempt: 2 }),
      { ...use(12, "s1", "r", "Read", { parent: "S" }), attempt: 2 },
    ];
    const live = buildGraphFromTrace(
      events,
      ctx({ status: "running", exitCode: null, finishedAt: null }),
    );
    expect(live.attempts.map((attempt) => attempt.lane?.status)).toEqual([
      "stopped",
      "running",
    ]);
    const liveAgent = mainLane(live, 1).steps[0].calls[0];
    expect(liveAgent.status).toBe("pending");
    expect(liveAgent.subagent?.status).toBe("running");
    expect(liveAgent.subagent?.steps[0].calls[0].status).toBe("pending");

    const ended = buildGraphFromTrace(
      events,
      ctx({ status: "failed", exitCode: 1 }),
    );
    expect(ended.attempts.map((attempt) => attempt.lane?.status)).toEqual([
      "stopped",
      "stopped",
    ]);
    expect(mainLane(ended, 1).steps[0].calls[0].subagent?.status).toBe(
      "unknown",
    );
  });

  it("notes a truncated trace", () => {
    const graph = buildGraphFromTrace(
      [
        attemptEv(1),
        use(2, "m1", "a", "Bash"),
        { kind: "truncated", at: t(3), attempt: 1 },
      ],
      ctx({ status: "running", finishedAt: null }),
    );
    expect(graph.attempts[0].truncated).toBe(true);
    expect(graph.notes).toContain(
      "Trace was truncated at 20000 events; later activity is not shown.",
    );
  });

  it("notes an agent run whose trace recorded nothing", () => {
    const graph = buildGraphFromTrace(
      [],
      ctx({ status: "failed", exitCode: 1 }),
    );
    expect(graph.attempts).toEqual([]);
    expect(graph.notes.join(" ")).toMatch(/no agent activity/i);
    expect(graph.totals).toEqual({
      toolCalls: 0,
      errors: 0,
      subagents: 0,
      steps: 0,
      byCategory: zeroCategories,
      filesRead: [],
      filesChanged: [],
    });
  });

  it("copies run identity from the context", () => {
    const run = ctx({
      jobId: "nightly",
      runId: "r-9",
      status: "partial",
      exitCode: 2,
    });
    expect(buildGraphFromTrace(sampleEvents, run)).toMatchObject({
      jobId: "nightly",
      runId: "r-9",
      kind: "agent",
      status: "partial",
      exitCode: 2,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  });
});

/** The line runJob (src/daemon/job-runner.ts) writes before attempt N+1. */
const retryMarker = (
  attempt: number,
  maxRetries: number,
  previousStatus: string,
): string =>
  `\n=== retry ${attempt}/${maxRetries} (previous attempt: ${previousStatus}) ===\n`;

/** A retried attempt's outcome, as only the retry marker records it. */
const retriedOutcome = (subtype: string) => ({
  isError: true,
  subtype,
  durationMs: null,
  numTurns: null,
  costUsd: null,
  permissionDenials: 0,
  text: null,
});

describe("buildGraphFromAgentLog", () => {
  // Written the way job-runner's extractTextFromStreamJson writes output.log:
  // text blocks as-is, each tool_use as "\n> [Name] detail\n", tool results as
  // plain text, and the daemon's retry marker between attempts.
  const log = [
    "I'll check the repo state first.",
    "\n> [Bash] $ git status --short\n",
    " M src/a.ts\n?? notes.md\n",
    "\n> [Read] Reading /repo/src/a.ts\n",
    "1\texport const a = 1;\n2\t// > [Bash] quoted in a file\n",
    "\n> [Agent] Agent: review the diff\n",
    "Checklist from the reviewer:\n> [x] types updated\n> [Bash] ran by hand\n",
    "\n> [Bash] $ cd /repo && \\\n  npm test\n",
    "> ai-scheduler@0.1.0 test\nTests  3 passed (3)\n",
    "\n> [Grep] Grep: TODO\n",
    "src/a.ts:3: // TODO\n",
    "\n> [TodoWrite]\n",
    "Todos have been modified successfully.\n",
    "\n> [mcp__atlassian__jira_get_issue]\n",
    '{"key":"ABC-1","status":"Done"}\n',
    "Repo is clean.",
    "\n=== retry 1/2 (previous attempt: failed) ===\n",
    "Retrying the edit.",
    "\n> [Edit] Editing /repo/src/a.ts\n",
    "The file /repo/src/a.ts has been updated successfully.\n",
    "\n> [Write] Writing /repo/notes.md\n",
    "File created successfully at: /repo/notes.md\n",
    "\n> [Edit] Editing /repo/src/a.ts\n",
    "\n> [Skill] Skill: deploy\n",
    "Deployed.",
  ].join("");

  it("reconstructs every tool call per attempt, skipping look-alike lines", () => {
    const graph = buildGraphFromAgentLog(log, ctx());
    expect(graph.source).toBe("log");
    expect(graph.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);

    const [first, second] = graph.attempts.map(
      (attempt) => attempt.lane as RunGraphLane,
    );
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0].narration).toBeNull();
    expect(
      first.steps[0].calls.map((call) => [call.name, call.summary, call.path]),
    ).toEqual([
      ["Bash", "$ git status --short", null],
      ["Read", "/repo/src/a.ts", "/repo/src/a.ts"],
      ["Agent", "review the diff", null],
      ["Bash", "$ cd /repo && \\", null],
      ["Grep", "TODO", null],
      ["TodoWrite", "", null],
      ["mcp__atlassian__jira_get_issue", "", null],
    ]);
    expect(first.steps[0].calls[6]).toMatchObject({
      label: "jira_get_issue",
      server: "atlassian",
      category: "mcp",
    });
    expect(
      second.steps[0].calls.map((call) => [call.name, call.summary, call.path]),
    ).toEqual([
      ["Edit", "/repo/src/a.ts", "/repo/src/a.ts"],
      ["Write", "/repo/notes.md", "/repo/notes.md"],
      ["Edit", "/repo/src/a.ts", "/repo/src/a.ts"],
      ["Skill", "deploy", null],
    ]);

    const calls = [...first.steps[0].calls, ...second.steps[0].calls];
    for (const call of calls) {
      expect(call).toMatchObject({
        status: "unknown",
        startedAt: null,
        durationMs: null,
        resultPreview: null,
        subagent: null,
      });
    }
    expect(new Set(calls.map((call) => call.id)).size).toBe(11);
  });

  it("marks retried attempts as failed and the last one from the run status", () => {
    const status = (
      runStatus: RunGraphContext["status"],
    ): (string | undefined)[] =>
      buildGraphFromAgentLog(log, ctx({ status: runStatus })).attempts.map(
        (attempt) => attempt.lane?.status,
      );
    expect(status("success")).toEqual(["error", "ok"]);
    expect(status("running")).toEqual(["error", "running"]);
    expect(status("partial")).toEqual(["error", "error"]);
    expect(status("failed")).toEqual(["error", "error"]);
    expect(status("timeout")).toEqual(["error", "stopped"]);
  });

  it("records how each retried attempt ended, from the daemon's retry marker", () => {
    const retried = [
      "\n> [Bash] $ npm test\n",
      "Tests  1 failed (3)\n",
      retryMarker(1, 3, "failed"),
      "\n> [Bash] $ npm test\n",
      "Tests  3 passed (3), 1 comment not posted\n",
      retryMarker(2, 3, "partial"),
      "\n> [Bash] $ npm test\n",
      "Tests  3 passed (3)\n",
    ].join("");
    const graph = buildGraphFromAgentLog(retried, ctx({ status: "success" }));
    expect(graph.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("failed"),
      retriedOutcome("partial"),
      // The last attempt's status comes from the run status, not a marker.
      null,
    ]);
    expect(graph.attempts.map((attempt) => attempt.lane?.status)).toEqual([
      "error",
      "error",
      "ok",
    ]);

    // A live run whose retry has just started: the marker already says how
    // the previous attempt ended.
    const live = buildGraphFromAgentLog(
      `\n> [Bash] $ npm test\n${retryMarker(1, 2, "failed")}`,
      ctx({ status: "running", exitCode: null, finishedAt: null }),
    );
    expect(live.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("failed"),
      null,
    ]);
    expect(live.attempts.map((attempt) => attempt.lane?.status)).toEqual([
      "error",
      "running",
    ]);
  });

  it("leaves a retried attempt's outcome unknown when its marker names no retried status", () => {
    // runJob retries only failed and partial attempts (and, before 2026-08-20,
    // timeouts), so a marker naming anything else (or nothing) does not say how
    // the attempt ended.
    for (const previous of ["", "success", "Failed"]) {
      const graph = buildGraphFromAgentLog(
        `\n> [Bash] $ npm test\n${retryMarker(1, 1, previous)}Done.`,
        ctx({ status: "success" }),
      );
      expect(graph.attempts).toHaveLength(2);
      expect(graph.attempts[0].outcome).toBeNull();
      expect(graph.attempts[0].lane?.status).toBe("error");
    }
  });

  it("records timed-out attempts that daemons before 2026-08-20 retried", () => {
    // Shape of setup-health/2026-07-06T07-00-00-aed476: three timed-out attempts
    // were retried, and the last one timed out too.
    const skill =
      "\n> [Skill] Skill: setup-health\nLaunching skill: setup-health\n";
    const graph = buildGraphFromAgentLog(
      [
        skill,
        retryMarker(1, 3, "timeout"),
        skill,
        retryMarker(2, 3, "timeout"),
        skill,
        retryMarker(3, 3, "timeout"),
        skill,
      ].join(""),
      ctx({ status: "timeout", exitCode: null }),
    );
    expect(graph.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("timeout"),
      retriedOutcome("timeout"),
      retriedOutcome("timeout"),
      null,
    ]);
    expect(graph.attempts.map((attempt) => attempt.lane?.status)).toEqual([
      "stopped",
      "stopped",
      "stopped",
      "stopped",
    ]);
  });

  it("keeps retry markers quoted in tool output inside the attempt that printed them", () => {
    // A genuine retry (1/2); attempt 2 then prints the head of another run's
    // output.log, which carries that run's own markers - the shape of
    // ai-researcher/2026-07-26T03-00-00-01b748, which read setup-health's log.
    const graph = buildGraphFromAgentLog(
      [
        "\n> [Bash] $ gh pr list\n",
        "error: HTTP 502\n",
        retryMarker(1, 2, "failed"),
        '\n> [Bash] $ DIR="data/runs/setup-health/2026-07-06T07-00-00-aed476"\n',
        'echo "--- head ---"; head -60 "$DIR/output.log"\n',
        "--- head ---\n",
        retryMarker(1, 3, "timeout"),
        retryMarker(2, 3, "timeout"),
        retryMarker(3, 3, "timeout"),
        "\n> [Read] Reading /repo/notes.md\n",
        "Done.",
      ].join(""),
      ctx({ status: "success" }),
    );
    expect(graph.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("failed"),
      null,
    ]);
    expect(
      graph.attempts[1].lane?.steps[0].calls.map((call) => call.name),
    ).toEqual(["Bash", "Read"]);
  });

  it("accepts only retry markers that count up from 1 under one maximum", () => {
    const attempts = (...markers: string[]): number =>
      buildGraphFromAgentLog(
        `${markers.map((marker) => `\n> [Bash] $ step\n${marker}`).join("")}\n> [Bash] $ last\n`,
        ctx(),
      ).attempts.length;
    expect(
      attempts(
        retryMarker(1, 3, "failed"),
        retryMarker(2, 3, "failed"),
        retryMarker(3, 3, "failed"),
      ),
    ).toBe(4);
    // Starting anywhere but 1.
    expect(attempts(retryMarker(2, 3, "failed"))).toBe(1);
    // Restarting at 1 after 3/3 (a second quoted sequence).
    expect(
      attempts(
        retryMarker(1, 3, "failed"),
        retryMarker(2, 3, "failed"),
        retryMarker(3, 3, "failed"),
        retryMarker(1, 3, "failed"),
      ),
    ).toBe(4);
    // A different maximum than the first marker's.
    expect(
      attempts(retryMarker(1, 2, "failed"), retryMarker(2, 3, "failed")),
    ).toBe(2);
    // Past the maximum.
    expect(
      attempts(retryMarker(1, 1, "failed"), retryMarker(2, 1, "failed")),
    ).toBe(2);
  });

  it("never splits a log into more attempts than the run recorded", () => {
    // Shape of executive-review/2026-09-17T08-57-28-e1ae96: costs.json records one
    // attempt, but a Bash call tailed another job's output.log, whose own
    // `retry 1/3` marker continues a plausible sequence.
    const tail = [
      "\n> [Bash] $ for job in speedboat-cycle-cron; do\n",
      '  tail -c 1500 "data/runs/$job/latest/output.log"\ndone\n',
      "== speedboat cycle-cron 2026-09-17T06:45:00Z ==\n",
      "schedule-gate: getRoster failed: HTTP 404\n",
      retryMarker(1, 3, "failed"),
      "== speedboat cycle-cron 2026-09-17T06:45:35Z ==\nnothing to do today\n",
      "\n> [Write] Writing /repo/review.md\n",
      "File created successfully at: /repo/review.md\n",
    ].join("");
    const single = buildGraphFromAgentLog(tail, ctx({ expectedAttempts: 1 }));
    expect(single.attempts).toHaveLength(1);
    expect(single.attempts[0].outcome).toBeNull();
    expect(single.attempts[0].lane?.status).toBe("ok");
    expect(
      single.attempts[0].lane?.steps[0].calls.map((call) => call.name),
    ).toEqual(["Bash", "Write"]);

    // Two recorded attempts: the genuine 1/3, then a quoted 2/3 that would
    // otherwise continue the sequence.
    const twice = buildGraphFromAgentLog(
      `\n> [Bash] $ npm test\n${retryMarker(1, 3, "failed")}${tail.replace(
        "retry 1/3",
        "retry 2/3",
      )}`,
      ctx({ expectedAttempts: 2 }),
    );
    expect(twice.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("failed"),
      null,
    ]);
    expect(
      twice.attempts[1].lane?.steps[0].calls.map((call) => call.name),
    ).toEqual(["Bash", "Write"]);
  });

  it("totals the reconstructed calls and explains the limits", () => {
    const graph = buildGraphFromAgentLog(log, ctx());
    expect(graph.attempts[0].startedAt).toBe(ctx().startedAt);
    expect(graph.attempts[1].startedAt).toBeNull();
    expect(graph.totals).toEqual({
      toolCalls: 11,
      errors: 0,
      subagents: 0,
      steps: 2,
      byCategory: {
        ...zeroCategories,
        shell: 2,
        read: 1,
        agent: 1,
        search: 1,
        plan: 1,
        mcp: 1,
        edit: 3,
        skill: 1,
      },
      filesRead: ["/repo/src/a.ts"],
      filesChanged: ["/repo/src/a.ts", "/repo/notes.md"],
    });
    const notes = graph.notes.join(" ");
    expect(notes).toMatch(/output\.log/);
    expect(notes).toMatch(/before .*tracing/i);
    expect(notes).toMatch(/outcomes/i);
    expect(notes).toMatch(/timings/i);
    expect(notes).toMatch(/nesting/i);
    expect(notes).toMatch(/subagent tool calls appear inline/i);
  });

  it("gives a log without tool calls one attempt and no steps", () => {
    const graph = buildGraphFromAgentLog(
      "",
      ctx({ status: "running", finishedAt: null }),
    );
    expect(graph.attempts).toHaveLength(1);
    expect(graph.attempts[0].lane).toMatchObject({
      status: "running",
      steps: [],
    });
  });
});

describe("buildGraphFromScriptLog", () => {
  // Shaped like data/runs/daily-ops/*/output.log.
  const log = [
    "=== Daily summary (refreshes calendar, transcripts, agents) ===",
    "$ bun run scripts/summarize.ts --today",
    "",
    "=== Meeting Summarizer (today) ===",
    "Date range: 2026-09-28 to 2026-09-28",
    "Failed to search assigned(pr) from github.com: Unable to connect.",
    "Failed to fetch notifications from github.com: Unable to connect.",
    "Found 482 carried-forward action item(s)",
    "Fatal error: 322 |   message: response.message,",
    "FAILED: summarize",
    "=== Morning briefing (reads fresh DB) ===",
    "Briefing written.",
    "=== Action items ===",
    "FAILED: assess-actions",
    "=== Done ===",
    "",
    "=== retry 1/1 (previous attempt: partial) ===",
    "=== Daily summary (refreshes calendar, transcripts, agents) ===",
    "All good.",
    "=== Done ===",
    "",
    "=== giving up after 2 attempts: final status partial (exit code 2) ===",
    "",
  ].join("\n");

  it("splits each attempt into sections with failure and issue counts", () => {
    const graph = buildGraphFromScriptLog(
      log,
      ctx({ kind: "script", status: "partial", exitCode: 2 }),
    );
    expect(graph.source).toBe("script-log");
    expect(graph.attempts).toHaveLength(2);
    expect(graph.attempts.every((attempt) => attempt.lane === null)).toBe(true);

    const summarize = (index: number) =>
      graph.attempts[index].sections.map(
        ({ title, lineCount, failed, issueCount, firstIssue }) => ({
          title,
          lineCount,
          failed,
          issueCount,
          firstIssue,
        }),
      );
    expect(summarize(0)).toEqual([
      {
        title: "Daily summary (refreshes calendar, transcripts, agents)",
        lineCount: 1,
        failed: false,
        issueCount: 0,
        firstIssue: null,
      },
      {
        title: "Meeting Summarizer (today)",
        lineCount: 6,
        failed: true,
        issueCount: 4,
        firstIssue:
          "Failed to search assigned(pr) from github.com: Unable to connect.",
      },
      {
        title: "Morning briefing (reads fresh DB)",
        lineCount: 1,
        failed: false,
        issueCount: 0,
        firstIssue: null,
      },
      {
        title: "Action items",
        lineCount: 1,
        failed: true,
        issueCount: 1,
        firstIssue: "FAILED: assess-actions",
      },
      {
        title: "Done",
        lineCount: 0,
        failed: false,
        issueCount: 0,
        firstIssue: null,
      },
    ]);
    // The daemon's retry and giving-up markers are not sections.
    expect(summarize(1)).toEqual([
      {
        title: "Daily summary (refreshes calendar, transcripts, agents)",
        lineCount: 1,
        failed: false,
        issueCount: 0,
        firstIssue: null,
      },
      {
        title: "Done",
        lineCount: 0,
        failed: false,
        issueCount: 0,
        firstIssue: null,
      },
    ]);
    const ids = graph.attempts.flatMap((attempt) =>
      attempt.sections.map((section) => section.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.totals).toEqual({
      toolCalls: 0,
      errors: 0,
      subagents: 0,
      steps: 0,
      byCategory: zeroCategories,
      filesRead: [],
      filesChanged: [],
    });
    expect(graph.notes.join(" ")).toMatch(/=== title ===/);
    expect(graph.notes.join(" ")).toMatch(/FAILED/);
  });

  it("records how each retried attempt ended, from the daemon's retry marker", () => {
    const graph = buildGraphFromScriptLog(
      log,
      ctx({ kind: "script", status: "partial", exitCode: 2 }),
    );
    // The last attempt's status comes from the run status, not a marker.
    expect(graph.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("partial"),
      null,
    ]);

    const failedTwice = buildGraphFromScriptLog(
      [
        "=== Build ===",
        "FAILED: build",
        retryMarker(1, 2, "failed"),
        "=== Build ===",
        "FAILED: build",
        retryMarker(2, 2, "failed"),
        "=== Build ===",
        "ok",
      ].join("\n"),
      ctx({ kind: "script", status: "success" }),
    );
    expect(failedTwice.attempts.map((attempt) => attempt.outcome)).toEqual([
      retriedOutcome("failed"),
      retriedOutcome("failed"),
      null,
    ]);
  });

  it("leaves a retried attempt's outcome unknown when its marker names no retried status", () => {
    const graph = buildGraphFromScriptLog(
      `=== Build ===\nboom${retryMarker(1, 1, "")}=== Build ===\nok\n`,
      ctx({ kind: "script", status: "success" }),
    );
    expect(graph.attempts.map((attempt) => attempt.outcome)).toEqual([
      null,
      null,
    ]);
  });

  it("keeps a retry marker the script printed from another log inside its section", () => {
    // The script tails yesterday's output.log; this run itself ran once.
    const graph = buildGraphFromScriptLog(
      [
        "=== Compare with yesterday ===",
        "tail of yesterday's log:",
        "=== retry 1/3 (previous attempt: partial) ===",
        "done",
        "=== Done ===",
        "",
      ].join("\n"),
      ctx({ kind: "script", status: "success", expectedAttempts: 1 }),
    );
    expect(graph.attempts).toHaveLength(1);
    expect(
      graph.attempts[0].sections.map((section) => [
        section.title,
        section.lineCount,
      ]),
    ).toEqual([
      ["Compare with yesterday", 2],
      ["Done", 0],
    ]);
  });

  it("does not turn the daemon's timeout marker into a section", () => {
    const graph = buildGraphFromScriptLog(
      "=== Build ===\nstill going\n\n=== run timed out after 3600s and was killed. Not retrying: a timed-out run spent its full time budget and may already have side effects; raise 'timeout' in scheduler.yaml if this job needs more time. ===\n",
      ctx({ kind: "script", status: "timeout" }),
    );
    expect(
      graph.attempts[0].sections.map((section) => [
        section.title,
        section.lineCount,
      ]),
    ).toEqual([["Build", 1]]);
  });

  it("groups output before the first marker under Output only when it has content", () => {
    const titles = (text: string) =>
      buildGraphFromScriptLog(
        text,
        ctx({ kind: "script" }),
      ).attempts[0].sections.map((section) => [
        section.title,
        section.lineCount,
      ]);
    expect(titles("booting\n\n=== Build ===\nok\n")).toEqual([
      ["Output", 1],
      ["Build", 1],
    ]);
    expect(titles("\n  \n=== Build ===\nok\n")).toEqual([["Build", 1]]);
    expect(titles("hello\nworld\n")).toEqual([["Output", 2]]);
    expect(titles("")).toEqual([]);
  });

  it("trims the first issue to 200 characters", () => {
    const long = `   Error: ${"x".repeat(300)}`;
    const [section] = buildGraphFromScriptLog(
      `=== Step ===\n${long}\n`,
      ctx({ kind: "script" }),
    ).attempts[0].sections;
    expect(section.firstIssue).toBe(long.trim().slice(0, 200));
    expect(section.firstIssue).toHaveLength(200);
  });
});
