import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RunGraphAttempt,
  RunGraphCall,
  RunGraphLane,
} from "../../../shared/run-graph-types";
import { ApiError, getRunGraph } from "../api-client";
import {
  LANE_STEP_WINDOW,
  STEP_ROW_WINDOW,
  attemptOutcome,
  callStatusDisplay,
  categoryBreakdown,
  countLaneErrors,
  displayPath,
  elapsedMs,
  endResultText,
  focusRevealedItem,
  formatDurationMs,
  formatOffset,
  groupCalls,
  groupStatus,
  isRunGraph,
  listFiles,
  mayOverflow,
  splitPath,
  subagentStatusDisplay,
  windowList,
} from "../run-diagram";

let nextId = 0;
function call(overrides: Partial<RunGraphCall> = {}): RunGraphCall {
  nextId += 1;
  return {
    id: `toolu_${nextId}`,
    name: "Read",
    label: "Read",
    server: null,
    category: "read",
    summary: `src/file-${nextId}.ts`,
    path: null,
    status: "ok",
    startedAt: null,
    durationMs: null,
    resultPreview: null,
    subagent: null,
    ...overrides,
  };
}

function lane(
  calls: RunGraphCall[],
  overrides: Partial<RunGraphLane> = {},
): RunGraphLane {
  return {
    id: "main",
    label: "main",
    subagentType: null,
    status: "ok",
    summary: null,
    toolUses: null,
    durationMs: null,
    steps: [{ id: "step-1", startedAt: null, narration: null, calls }],
    ...overrides,
  };
}

describe("groupCalls", () => {
  it("folds a run of same-name successful calls into one group", () => {
    const reads = Array.from({ length: 12 }, () => call());
    const rows = groupCalls(reads);
    expect(rows).toHaveLength(1);
    // A group row no longer carries one status; groupStatus derives it from its calls.
    expect(rows[0]).toMatchObject({ kind: "group", name: "Read" });
    expect(rows[0].kind === "group" && rows[0].calls).toEqual(reads);
  });

  it("never folds an error and lets it split the surrounding run", () => {
    const failed = call({
      status: "error",
      resultPreview: "File does not exist.",
    });
    const rows = groupCalls([call(), call(), failed, call(), call()]);
    expect(
      rows.map((row) =>
        row.kind === "group"
          ? `group:${row.calls.length}`
          : `call:${row.call.status}`,
      ),
    ).toEqual(["group:2", "call:error", "group:2"]);
  });

  it("keeps consecutive errors as separate rows", () => {
    const rows = groupCalls([
      call({ status: "error" }),
      call({ status: "error" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["call", "call"]);
  });

  // Contract changed on purpose: status no longer splits a group, so that live polls keep row identity.
  it("breaks groups on a different tool name but not on an ok / pending / unknown status", () => {
    const rows = groupCalls([
      call(),
      call(),
      call({ name: "Bash", label: "Bash", category: "shell" }),
      call({ status: "ok" }),
      call({ status: "pending" }),
      call({ status: "unknown" }),
    ]);
    expect(
      rows.map((row) =>
        row.kind === "group"
          ? `${row.name}x${row.calls.length}`
          : row.call.name,
      ),
    ).toEqual(["Readx2", "Bash", "Readx3"]);
  });

  it("keeps a group's kind and key when one of its parallel calls goes from pending to ok", () => {
    // Three parallel Reads from one assistant message, as two successive 3s polls see them.
    const poll = (statuses: RunGraphCall["status"][]) =>
      groupCalls(
        statuses.map((status, index) =>
          call({ id: `toolu_parallel_${index + 1}`, status }),
        ),
      ).map((row) => ({ kind: row.kind, key: row.key }));
    const first = poll(["pending", "pending", "pending"]);
    expect(first).toHaveLength(1);
    expect(first[0].kind).toBe("group");
    expect(poll(["ok", "pending", "pending"])).toEqual(first);
    expect(poll(["ok", "ok", "ok"])).toEqual(first);
  });

  it("never gives a single row and a group row the same key", () => {
    const lone = call({ id: "toolu_shared" });
    const [single] = groupCalls([lone]);
    const [group] = groupCalls([lone, call()]);
    expect(single.kind).toBe("call");
    expect(group.kind).toBe("group");
    expect(single.key).not.toBe(group.key);
  });

  it("keeps each subagent-spawning call on its own row so its lane stays reachable", () => {
    const agent = () =>
      call({
        name: "Agent",
        label: "Agent",
        category: "agent",
        subagent: lane([]),
      });
    expect(groupCalls([agent(), agent()]).map((row) => row.kind)).toEqual([
      "call",
      "call",
    ]);
  });

  it("returns single calls as plain rows, with unique keys", () => {
    expect(groupCalls([])).toEqual([]);
    const rows = groupCalls([call(), call({ name: "Grep" }), call(), call()]);
    expect(rows.map((row) => row.kind)).toEqual(["call", "call", "group"]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("windowList", () => {
  it("shows a lane of up to 40 steps in full", () => {
    expect(windowList(40, LANE_STEP_WINDOW, false)).toEqual({
      headEnd: 40,
      tailStart: 40,
      hidden: 0,
    });
  });

  it("shows the first 20 and last 10 steps of a longer lane", () => {
    expect(windowList(41, LANE_STEP_WINDOW, false)).toEqual({
      headEnd: 20,
      tailStart: 31,
      hidden: 11,
    });
    expect(windowList(340, LANE_STEP_WINDOW, false)).toEqual({
      headEnd: 20,
      tailStart: 330,
      hidden: 310,
    });
  });

  it("shows everything once expanded", () => {
    expect(windowList(340, LANE_STEP_WINDOW, true)).toEqual({
      headEnd: 340,
      tailStart: 340,
      hidden: 0,
    });
  });

  it("shows 8 rows of a step with more than 12", () => {
    expect(windowList(12, STEP_ROW_WINDOW, false).hidden).toBe(0);
    expect(windowList(13, STEP_ROW_WINDOW, false)).toEqual({
      headEnd: 8,
      tailStart: 13,
      hidden: 5,
    });
  });

  it("treats an empty list as fully shown", () => {
    expect(windowList(0, LANE_STEP_WINDOW, false)).toEqual({
      headEnd: 0,
      tailStart: 0,
      hidden: 0,
    });
  });
});

describe("countLaneErrors", () => {
  it("counts error calls in the lane and in every nested subagent lane", () => {
    const deepest = lane([call({ status: "error" })], { id: "toolu_deep" });
    const nested = lane(
      [
        call({ status: "error" }),
        call({ status: "error" }),
        call(),
        call({ name: "Agent", category: "agent", subagent: deepest }),
      ],
      { id: "toolu_nested" },
    );
    const main = lane([
      call({ status: "error" }),
      call({ status: "pending" }),
      call({ name: "Agent", category: "agent", subagent: nested }),
    ]);
    expect(countLaneErrors(main)).toBe(4);
    expect(countLaneErrors(nested)).toBe(3);
    expect(countLaneErrors(lane([call(), call({ status: "unknown" })]))).toBe(
      0,
    );
  });
});

describe("status display", () => {
  it("draws a pending call as live only while the run is running", () => {
    expect(callStatusDisplay("pending", true)).toBe("live");
    expect(callStatusDisplay("pending", false)).toBe("no-result");
    expect(callStatusDisplay("unknown", true)).toBe("none");
    expect(callStatusDisplay("error", false)).toBe("error");
  });

  it("summarizes a group: pending calls first, with a count when only some are pending", () => {
    const calls = (...statuses: RunGraphCall["status"][]) =>
      statuses.map((status) => call({ status }));
    expect(groupStatus(calls("ok", "pending", "pending"), true)).toEqual({
      display: "live",
      pendingCount: 2,
    });
    // Once the run is over, a call that never answered has no result.
    expect(groupStatus(calls("ok", "pending", "ok"), false)).toEqual({
      display: "no-result",
      pendingCount: 1,
    });
    // Every call pending: the row reads like a single pending call, no count.
    expect(groupStatus(calls("pending", "pending"), true)).toEqual({
      display: "live",
      pendingCount: null,
    });
    expect(groupStatus(calls("ok", "ok"), false)).toEqual({
      display: "ok",
      pendingCount: null,
    });
    // An unknown outcome (log reconstruction, stopped background task) is not a success.
    expect(groupStatus(calls("ok", "unknown"), false)).toEqual({
      display: "none",
      pendingCount: null,
    });
  });

  it("marks a subagent failed when its spawning call failed, whatever the lane says", () => {
    expect(subagentStatusDisplay("ok", "error", false)).toBe("error");
    expect(subagentStatusDisplay("running", "ok", false)).toBe("no-result");
    expect(subagentStatusDisplay("running", "ok", true)).toBe("live");
    expect(subagentStatusDisplay("stopped", "ok", false)).toBe("stopped");
  });

  it("reports the run status for the last attempt and the recorded outcome for retried ones", () => {
    const attempt = (outcome: RunGraphAttempt["outcome"]): RunGraphAttempt => ({
      attempt: 1,
      startedAt: null,
      model: null,
      lane: null,
      sections: [],
      outcome,
      truncated: false,
    });
    const failedOutcome = {
      isError: true,
      subtype: "error_max_turns",
      durationMs: null,
      numTurns: null,
      costUsd: null,
      permissionDenials: 0,
      text: null,
    };
    expect(attemptOutcome(attempt(failedOutcome), false, "success")).toEqual({
      text: "error max turns · retried",
      tone: "error",
    });
    expect(attemptOutcome(attempt(null), false, "success")).toEqual({
      text: "no result · retried",
      tone: "warning",
    });
    expect(attemptOutcome(attempt(failedOutcome), true, "failed")).toEqual({
      text: "failed",
      tone: "error",
    });
    expect(attemptOutcome(attempt(null), true, "running").tone).toBe("live");
  });

  it("names a retried attempt by its result subtype, amber for partial and red for other errors", () => {
    const retried = (
      isError: boolean,
      subtype: string | null,
    ): RunGraphAttempt => ({
      attempt: 1,
      startedAt: null,
      model: null,
      lane: null,
      sections: [],
      outcome: {
        isError,
        subtype,
        durationMs: null,
        numTurns: null,
        costUsd: null,
        permissionDenials: 0,
        text: null,
      },
      truncated: false,
    });
    const label = (isError: boolean, subtype: string | null) =>
      attemptOutcome(retried(isError, subtype), false, "success");
    // Trace attempts carry the CLI's result subtype.
    expect(label(true, "error_during_execution")).toEqual({
      text: "error during execution · retried",
      tone: "error",
    });
    // Log reconstructions record the attempt's run status as the subtype.
    expect(label(true, "failed")).toEqual({
      text: "failed · retried",
      tone: "error",
    });
    expect(label(true, "partial")).toEqual({
      text: "partial · retried",
      tone: "warning",
    });
    expect(label(true, null)).toEqual({
      text: "error · retried",
      tone: "error",
    });
    expect(label(false, "success")).toEqual({
      text: "success · retried",
      tone: "warning",
    });
    expect(label(false, null)).toEqual({
      text: "ok · retried",
      tone: "warning",
    });
  });
});

describe("endResultText", () => {
  const withEnd = (
    narrations: Array<string | null>,
    text: string | null,
    summary: string | null = null,
  ): RunGraphAttempt => ({
    attempt: 1,
    startedAt: null,
    model: null,
    lane: lane([], {
      summary,
      steps: narrations.map((narration, index) => ({
        id: `s-${index}`,
        startedAt: null,
        narration,
        calls: [],
      })),
    }),
    sections: [],
    outcome:
      text === null
        ? null
        : {
            isError: false,
            subtype: "success",
            durationMs: null,
            numTurns: null,
            costUsd: null,
            permissionDenials: 0,
            text,
          },
    truncated: false,
  });

  it("omits the result when it repeats the last step's narration", () => {
    expect(
      endResultText(
        withEnd(["Looking.", "All 3 files read."], "All 3 files read.\n"),
        true,
      ),
    ).toBeNull();
    expect(
      endResultText(withEnd(["Looking.", "  Done  "], null, "Done"), true),
    ).toBeNull();
  });

  it("keeps a result that differs from the last narration, or only matches an earlier one", () => {
    expect(
      endResultText(
        withEnd(["Looking.", "Reading."], "Report: 3 files."),
        true,
      ),
    ).toBe("Report: 3 files.");
    expect(
      endResultText(
        withEnd(["Report: 3 files.", null], "Report: 3 files."),
        true,
      ),
    ).toBe("Report: 3 files.");
    expect(endResultText(withEnd([], "Report."), true)).toBe("Report.");
  });

  it("falls back to the lane summary only on the last attempt", () => {
    expect(endResultText(withEnd(["a"], null, "Summary."), true)).toBe(
      "Summary.",
    );
    expect(endResultText(withEnd(["a"], null, "Summary."), false)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations from milliseconds to hours", () => {
    expect(formatDurationMs(450)).toBe("450ms");
    expect(formatDurationMs(1500)).toBe("1.5s");
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(60_000)).toBe("1m");
    expect(formatDurationMs(72_000)).toBe("1m 12s");
    expect(formatDurationMs(3_723_000)).toBe("1h 2m");
  });

  it("returns null for unknown or invalid durations", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(Number.NaN)).toBeNull();
    expect(formatDurationMs(-5)).toBeNull();
  });

  it("formats offsets from the attempt start in whole seconds", () => {
    const start = "2026-09-28T10:00:00.000Z";
    expect(formatOffset(start, "2026-09-28T10:01:12.900Z")).toBe("+1m 12s");
    expect(formatOffset(start, start)).toBe("+0s");
    expect(formatOffset(start, "2026-09-28T09:59:58.000Z")).toBe("+0s");
    expect(formatOffset(start, null)).toBeNull();
    expect(formatOffset("not a date", start)).toBeNull();
  });

  it("measures elapsed time up to now for a live run", () => {
    const now = Date.parse("2026-09-28T10:02:00.000Z");
    expect(elapsedMs("2026-09-28T10:00:00.000Z", null, now)).toBe(120_000);
    expect(
      elapsedMs("2026-09-28T10:00:00.000Z", "2026-09-28T10:00:30.000Z", now),
    ).toBe(30_000);
    expect(elapsedMs(null, null, now)).toBeNull();
  });

  it("offers a 'more' toggle only for text that can exceed the clamp", () => {
    expect(mayOverflow("Short narration.", 2)).toBe(false);
    expect(mayOverflow("x".repeat(120), 2)).toBe(true);
    expect(mayOverflow("one\ntwo\nthree", 2)).toBe(true);
    expect(mayOverflow("one\ntwo", 2)).toBe(false);
  });
});

describe("categoryBreakdown", () => {
  it("lists categories with calls in contract order with their share", () => {
    const shares = categoryBreakdown({
      shell: 1,
      read: 3,
      edit: 0,
      web: -2,
      mcp: Number.NaN,
    });
    expect(shares).toEqual([
      { category: "read", count: 3, percent: 75 },
      { category: "shell", count: 1, percent: 25 },
    ]);
    expect(categoryBreakdown(undefined)).toEqual([]);
  });
});

describe("files", () => {
  it("lists changed files first and each path once", () => {
    expect(
      listFiles(["/r/a.ts", "/r/b.ts", "/r/a.ts"], ["/r/b.ts", "/r/c.ts"]),
    ).toEqual([
      { path: "/r/b.ts", change: "changed" },
      { path: "/r/c.ts", change: "changed" },
      { path: "/r/a.ts", change: "read" },
    ]);
  });

  it("splits a path so the file name can stay visible", () => {
    expect(splitPath("/Users/me/project/src/app.ts")).toEqual({
      dir: "/Users/me/project/src/",
      base: "app.ts",
    });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("displayPath", () => {
  it("shows paths inside the job directory relative to it", () => {
    expect(
      displayPath(
        "/Users/me/Programming/x/src/a.ts",
        "/Users/me/Programming/x",
      ),
    ).toBe("src/a.ts");
    expect(displayPath("/srv/job/a.txt", "/srv/job/")).toBe("a.txt");
  });

  it("matches macOS /private aliases of the job directory", () => {
    expect(
      displayPath(
        "/private/tmp/run/scratchpad/sample/a.txt",
        "/tmp/run/scratchpad",
      ),
    ).toBe("sample/a.txt");
    expect(displayPath("/tmp/run/a.txt", "/private/tmp/run")).toBe("a.txt");
  });

  it("collapses the home directory for paths outside the job directory", () => {
    expect(
      displayPath("/Users/akorinek/Programming/x/src/a.ts", "/private/tmp/job"),
    ).toBe("~/Programming/x/src/a.ts");
    // A sibling that only shares a name prefix is outside the directory.
    expect(displayPath("/Users/me/proj2/a.ts", "/Users/me/proj")).toBe(
      "~/proj2/a.ts",
    );
    expect(displayPath("/Users/me/proj", "/Users/me/proj")).toBe("~/proj");
    expect(displayPath("/Users/me/a.ts", null)).toBe("~/a.ts");
  });

  it("leaves other text and paths unchanged", () => {
    expect(displayPath("$ ls /Users/me/proj", "/Users/me/proj")).toBe(
      "$ ls /Users/me/proj",
    );
    expect(displayPath("*.txt", "/Users/me/proj")).toBe("*.txt");
    expect(displayPath("/opt/tool/bin", undefined)).toBe("/opt/tool/bin");
    expect(displayPath("/etc/hosts", "/")).toBe("/etc/hosts");
    expect(displayPath("", "/Users/me/proj")).toBe("");
  });
});

describe("focusRevealedItem", () => {
  function node(tagName: string, firstElementChild: unknown = null) {
    return { tagName, firstElementChild, tabIndex: 0, focus: vi.fn() };
  }
  const list = (...items: unknown[]) =>
    ({ children: items }) as unknown as ParentNode;

  it("focuses a revealed row that is itself a button", () => {
    const button = node("BUTTON");
    const row = node("LI", button);
    focusRevealedItem(list(node("LI"), row), 1);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(row.focus).not.toHaveBeenCalled();
    expect(row.tabIndex).toBe(0);
  });

  it("makes a non-interactive revealed item programmatically focusable and focuses it", () => {
    const marker = node("SPAN");
    const item = node("LI", marker);
    focusRevealedItem(list(node("LI"), node("LI"), item), 2);
    expect(item.tabIndex).toBe(-1);
    expect(item.focus).toHaveBeenCalledTimes(1);
    expect(marker.focus).not.toHaveBeenCalled();
  });

  it("does nothing when the list or the item is missing", () => {
    expect(() => focusRevealedItem(null, 0)).not.toThrow();
    expect(() => focusRevealedItem(list(node("LI")), 3)).not.toThrow();
  });
});

describe("isRunGraph", () => {
  const valid = {
    jobId: "job",
    runId: "run",
    kind: "agent",
    source: "trace",
    status: "success",
    exitCode: 0,
    startedAt: "2026-09-28T10:00:00.000Z",
    finishedAt: null,
    notes: [],
    totals: {
      toolCalls: 0,
      errors: 0,
      subagents: 0,
      steps: 0,
      byCategory: {},
      filesRead: [],
      filesChanged: [],
    },
    attempts: [
      {
        attempt: 1,
        startedAt: null,
        model: null,
        lane: { id: "main", steps: [] },
        sections: [],
        outcome: null,
        truncated: false,
      },
      {
        attempt: 2,
        startedAt: null,
        model: null,
        lane: null,
        sections: [],
        outcome: null,
        truncated: false,
      },
    ],
  };

  it("accepts a graph with the fields the diagram reads", () => {
    expect(isRunGraph(valid)).toBe(true);
  });

  it("rejects error bodies and graphs missing the arrays the diagram iterates", () => {
    expect(isRunGraph(null)).toBe(false);
    expect(isRunGraph({ error: "Run not found" })).toBe(false);
    expect(isRunGraph({ ...valid, kind: "other" })).toBe(false);
    expect(isRunGraph({ ...valid, notes: undefined })).toBe(false);
    expect(
      isRunGraph({ ...valid, totals: { ...valid.totals, filesRead: null } }),
    ).toBe(false);
    expect(
      isRunGraph({
        ...valid,
        attempts: [{ ...valid.attempts[0], lane: { id: "main" } }],
      }),
    ).toBe(false);
    expect(
      isRunGraph({
        ...valid,
        attempts: [{ ...valid.attempts[0], sections: undefined }],
      }),
    ).toBe(false);
  });
});

describe("run graph API read", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the encoded graph path without caching and passes the abort signal", async () => {
    const graph = { jobId: "job name", runId: "run/1", kind: "agent" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(graph)));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await getRunGraph("job name", "run/1", controller.signal)).toEqual(
      graph,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/job%20name/run%2F1/graph",
      expect.objectContaining({ cache: "no-store", signal: controller.signal }),
    );
  });

  it("surfaces a missing run as a 404 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Run not found" }), {
          status: 404,
        }),
      ),
    );
    const error = await getRunGraph("job", "gone").catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: "Run not found" });
  });
});
