import { TRACE_MAX_EVENTS } from "./run-trace-types";
import type {
  TraceEvent,
  TraceResultEvent,
  TraceSubagentEvent,
  TraceToolUseEvent,
} from "./run-trace-types";
import { TOOL_CATEGORIES } from "./run-graph-types";
import type {
  RunGraph,
  RunGraphAttempt,
  RunGraphCall,
  RunGraphLane,
  RunGraphLaneStatus,
  RunGraphOutcome,
  RunGraphSection,
  RunGraphSource,
  RunGraphStep,
  RunGraphTotals,
  ToolCategory,
} from "./run-graph-types";
import type { RunStatus } from "./types";

/**
 * Builds the run page's Diagram model (RunGraph) from what a run left on disk.
 * Pure - the daemon's run-graph-reader does the file I/O.
 */

export interface RunGraphContext {
  jobId: string;
  runId: string;
  kind: "agent" | "script";
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * How many attempts the run recorded (costs.json has one entry per attempt), when
   * known. An output.log is never split into more attempts than this, so retry
   * markers quoted from another run's log cannot add phantom attempts.
   */
  expectedAttempts?: number;
}

const MAIN_LANE = "main";
const MAIN_LANE_LABEL = "Main agent";

const TOOLS_BY_CATEGORY: Partial<Record<ToolCategory, string[]>> = {
  read: ["Read", "NotebookRead", "LS"],
  search: ["Glob", "Grep", "ToolSearch", "LSP"],
  edit: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  shell: ["Bash", "BashOutput", "KillShell", "KillBash", "Monitor"],
  web: ["WebFetch", "WebSearch"],
  agent: ["Agent", "Task", "SendMessage"],
  skill: ["Skill", "SlashCommand"],
  plan: [
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "TaskStop",
    "EnterPlanMode",
    "ExitPlanMode",
    "AskUserQuestion",
    "ScheduleWakeup",
  ],
};

// A Map, not an object lookup, so names like "constructor" are not found on the prototype.
const CATEGORY_BY_TOOL = new Map<string, ToolCategory>(
  Object.entries(TOOLS_BY_CATEGORY).flatMap(([category, names]) =>
    (names ?? []).map((name): [string, ToolCategory] => [
      name,
      category as ToolCategory,
    ]),
  ),
);

/** "mcp__<server>__<tool>"; the server part ends at the first "__". */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

export function categorizeTool(name: string): {
  category: ToolCategory;
  label: string;
  server: string | null;
} {
  const mcp = MCP_TOOL.exec(name);
  if (mcp) return { category: "mcp", label: mcp[2], server: mcp[1] };
  return {
    category: CATEGORY_BY_TOOL.get(name) ?? "other",
    label: name,
    server: null,
  };
}

// ---------------------------------------------------------------------------
// trace.jsonl parsing

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string/null field; undefined when the value has the wrong type. An absent field reads as null. */
function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validates one parsed line. Fields that decide structure (ids, parent,
 * messageId, text, status flags) must have the contract's type or the line is
 * dropped; display-only fields degrade to null / "" instead.
 */
function toTraceEvent(raw: unknown): TraceEvent | null {
  if (!isRecord(raw)) return null;
  const { at, attempt, kind } = raw;
  if (
    typeof at !== "string" ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    return null;
  }
  const base = { at, attempt };
  switch (kind) {
    case "attempt":
      return { ...base, kind, version: 1 };
    case "session":
      return {
        ...base,
        kind,
        model: nullableString(raw.model) ?? null,
        cliVersion: nullableString(raw.cliVersion) ?? null,
      };
    case "text": {
      const parent = nullableString(raw.parent);
      const messageId = nullableString(raw.messageId);
      if (
        parent === undefined ||
        messageId === undefined ||
        typeof raw.text !== "string"
      )
        return null;
      return { ...base, kind, parent, messageId, text: raw.text };
    }
    case "tool_use": {
      const parent = nullableString(raw.parent);
      const messageId = nullableString(raw.messageId);
      if (parent === undefined || messageId === undefined) return null;
      if (typeof raw.id !== "string" || typeof raw.name !== "string")
        return null;
      const agent = isRecord(raw.agent)
        ? {
            description: nullableString(raw.agent.description) ?? null,
            subagentType: nullableString(raw.agent.subagentType) ?? null,
          }
        : null;
      return {
        ...base,
        kind,
        parent,
        messageId,
        id: raw.id,
        name: raw.name,
        summary: typeof raw.summary === "string" ? raw.summary : "",
        path: nullableString(raw.path) ?? null,
        agent,
      };
    }
    case "tool_result": {
      const parent = nullableString(raw.parent);
      if (
        parent === undefined ||
        typeof raw.id !== "string" ||
        typeof raw.isError !== "boolean" ||
        (raw.launched !== undefined && typeof raw.launched !== "boolean")
      )
        return null;
      return {
        ...base,
        kind,
        parent,
        id: raw.id,
        isError: raw.isError,
        preview: typeof raw.preview === "string" ? raw.preview : "",
        // Older traces have no launched flag; keep it absent for them.
        ...(raw.launched === undefined ? {} : { launched: raw.launched }),
      };
    }
    case "subagent":
      if (typeof raw.toolUseId !== "string" || typeof raw.status !== "string")
        return null;
      return {
        ...base,
        kind,
        toolUseId: raw.toolUseId,
        status: raw.status,
        summary: nullableString(raw.summary) ?? null,
        toolUses: nullableNumber(raw.toolUses),
        durationMs: nullableNumber(raw.durationMs),
      };
    case "result":
      if (typeof raw.isError !== "boolean") return null;
      return {
        ...base,
        kind,
        isError: raw.isError,
        subtype: nullableString(raw.subtype) ?? null,
        durationMs: nullableNumber(raw.durationMs),
        numTurns: nullableNumber(raw.numTurns),
        costUsd: nullableNumber(raw.costUsd),
        permissionDenials: nullableNumber(raw.permissionDenials) ?? 0,
        text: nullableString(raw.text) ?? null,
      };
    case "truncated":
      return { ...base, kind };
    default:
      return null;
  }
}

/**
 * One TraceEvent per line. Blank, unparsable (e.g. the half-written last line
 * of a live run) and structurally invalid lines are skipped.
 */
export function parseTraceLines(content: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = toTraceEvent(parsed);
    if (event) events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Shared graph assembly

function emptyTotals(): RunGraphTotals {
  const byCategory = Object.fromEntries(
    TOOL_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ToolCategory, number>;
  return {
    toolCalls: 0,
    errors: 0,
    subagents: 0,
    steps: 0,
    byCategory,
    filesRead: [],
    filesChanged: [],
  };
}

/** Totals over every attempt and, recursively, every subagent lane. */
function computeTotals(attempts: RunGraphAttempt[]): RunGraphTotals {
  const totals = emptyTotals();
  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const visitLane = (lane: RunGraphLane): void => {
    for (const step of lane.steps) {
      totals.steps += 1;
      for (const call of step.calls) {
        totals.toolCalls += 1;
        totals.byCategory[call.category] += 1;
        if (call.status === "error") totals.errors += 1;
        if (call.path && call.category === "read") filesRead.add(call.path);
        // A failed or denied Write/Edit changed nothing.
        if (call.path && call.category === "edit" && call.status !== "error")
          filesChanged.add(call.path);
        if (call.subagent) {
          totals.subagents += 1;
          visitLane(call.subagent);
        }
      }
    }
  };
  for (const attempt of attempts) {
    if (attempt.lane) visitLane(attempt.lane);
  }
  totals.filesRead = [...filesRead];
  totals.filesChanged = [...filesChanged];
  return totals;
}

function assembleGraph(
  ctx: RunGraphContext,
  source: RunGraphSource,
  attempts: RunGraphAttempt[],
  notes: string[],
): RunGraph {
  return {
    jobId: ctx.jobId,
    runId: ctx.runId,
    kind: ctx.kind,
    source,
    status: ctx.status,
    exitCode: ctx.exitCode,
    startedAt: ctx.startedAt,
    finishedAt: ctx.finishedAt,
    attempts,
    totals: computeTotals(attempts),
    notes,
  };
}

function newLane(id: string, label: string): RunGraphLane {
  return {
    id,
    label,
    subagentType: null,
    status: "unknown",
    summary: null,
    toolUses: null,
    durationMs: null,
    steps: [],
  };
}

// ---------------------------------------------------------------------------
// From trace.jsonl

function elapsedMs(from: string | null, to: string): number | null {
  if (from === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return end - start;
}

function lifecycleStatus(status: string): RunGraphLaneStatus {
  switch (status) {
    case "started":
      return "running";
    case "completed":
      return "ok";
    case "failed":
    case "error":
      return "error";
    case "killed":
    case "stopped":
    case "cancelled":
    case "canceled":
      return "stopped";
    default:
      return "unknown";
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}

interface LaneBuild {
  lane: RunGraphLane;
  /** The step new events attach to, and the message id that started it. */
  step: RunGraphStep | null;
  stepMessageId: string | null;
  /** Latest status from subagent lifecycle events; null when none were captured. */
  lifecycle: RunGraphLaneStatus | null;
}

interface TrackedCall {
  call: RunGraphCall;
  laneId: string;
  agent: TraceToolUseEvent["agent"];
  /** A subagent notification decided this call's outcome; a tool_result no longer overrides it. */
  settledByLifecycle: boolean;
  /** Its tool_result only acknowledged a background launch, so only its lifecycle can settle it. */
  launched: boolean;
  /** The lifecycle event that ended its background work, kept for an acknowledgement streamed after it. */
  ended: TraceSubagentEvent | null;
}

function endsLifecycle(status: RunGraphLaneStatus): boolean {
  return status === "ok" || status === "error" || status === "stopped";
}

/**
 * Settles a launched call (async Agent, Bash run_in_background) from the
 * lifecycle event that ended its work. A stopped task has no outcome of its own.
 */
function settleLaunched(tracked: TrackedCall, ended: TraceSubagentEvent): void {
  const status = lifecycleStatus(ended.status);
  tracked.call.status =
    status === "ok" || status === "error" ? status : "unknown";
  tracked.call.durationMs =
    ended.durationMs ?? elapsedMs(tracked.call.startedAt, ended.at);
  // A background command's notification is its only result; a subagent's
  // summary is shown on its lane instead.
  if (tracked.call.category !== "agent" && ended.summary !== null)
    tracked.call.resultPreview = ended.summary;
  tracked.settledByLifecycle = true;
}

/** Sums a count over an attempt's results; null only when none reported it. */
function addCount(total: number | null, next: number | null): number | null {
  if (total === null) return next;
  return next === null ? total : total + next;
}

/**
 * An attempt's outcome over all its CLI results. When a turn ends while async
 * work is still running, the CLI emits a result, then continues with a new
 * init and a result of its own (Claude Code 2.1.283). Each result's duration,
 * turns and permission denials cover only its own query, while total_cost_usd
 * is cumulative: counts are summed, everything else comes from the last one.
 */
function foldResult(
  previous: RunGraphOutcome | null,
  event: TraceResultEvent,
): RunGraphOutcome {
  return {
    isError: event.isError,
    subtype: event.subtype,
    durationMs: addCount(previous?.durationMs ?? null, event.durationMs),
    numTurns: addCount(previous?.numTurns ?? null, event.numTurns),
    costUsd: event.costUsd,
    permissionDenials:
      (previous?.permissionDenials ?? 0) + event.permissionDenials,
    text: event.text,
  };
}

function buildTraceAttempt(
  attempt: number,
  events: TraceEvent[],
  ctx: RunGraphContext,
  isLastAttempt: boolean,
): RunGraphAttempt {
  const runIsLive = ctx.status === "running" && isLastAttempt;
  const lanes = new Map<string, LaneBuild>();
  const calls = new Map<string, TrackedCall>();
  /** Lane that reported a tool_result whose tool_use was never captured. */
  const unmatchedResultLane = new Map<string, string>();
  let startedAt: string | null = null;
  let model: string | null = null;
  let outcome: RunGraphOutcome | null = null;
  let truncated = false;

  const laneFor = (id: string): LaneBuild => {
    let entry = lanes.get(id);
    if (!entry) {
      entry = {
        lane: newLane(id, id === MAIN_LANE ? MAIN_LANE_LABEL : "Subagent"),
        step: null,
        stepMessageId: null,
        lifecycle: null,
      };
      lanes.set(id, entry);
    }
    return entry;
  };
  const startStep = (
    entry: LaneBuild,
    at: string,
    messageId: string | null,
  ): RunGraphStep => {
    const step: RunGraphStep = {
      id: `a${attempt}-${entry.lane.id}-${entry.lane.steps.length + 1}`,
      startedAt: at,
      narration: null,
      calls: [],
    };
    entry.lane.steps.push(step);
    entry.step = step;
    entry.stepMessageId = messageId;
    return step;
  };
  const main = laneFor(MAIN_LANE);

  for (const event of events) {
    switch (event.kind) {
      case "attempt":
        startedAt ??= event.at;
        break;
      case "session":
        model ??= event.model;
        break;
      case "text": {
        const entry = laneFor(event.parent ?? MAIN_LANE);
        const step =
          event.messageId === null ||
          entry.step === null ||
          entry.stepMessageId !== event.messageId
            ? startStep(entry, event.at, event.messageId)
            : entry.step;
        step.narration =
          step.narration === null
            ? event.text
            : `${step.narration}\n${event.text}`;
        break;
      }
      case "tool_use": {
        const entry = laneFor(event.parent ?? MAIN_LANE);
        const step =
          entry.step === null ||
          (event.messageId !== null && event.messageId !== entry.stepMessageId)
            ? startStep(entry, event.at, event.messageId)
            : entry.step;
        const call: RunGraphCall = {
          id: event.id,
          name: event.name,
          ...categorizeTool(event.name),
          summary: event.summary,
          path: event.path,
          status: "pending",
          startedAt: event.at,
          durationMs: null,
          resultPreview: null,
          subagent: null,
        };
        step.calls.push(call);
        if (!calls.has(event.id)) {
          calls.set(event.id, {
            call,
            laneId: entry.lane.id,
            agent: event.agent,
            settledByLifecycle: false,
            launched: false,
            ended: null,
          });
        }
        break;
      }
      case "tool_result": {
        const tracked = calls.get(event.id);
        if (!tracked) {
          unmatchedResultLane.set(event.id, event.parent ?? MAIN_LANE);
          break;
        }
        if (event.launched === true) {
          // Only a launch acknowledgement: it says nothing about how the work
          // ends and its latency is not the work's duration. The call stays
          // pending until its lifecycle ends, which may already have happened.
          tracked.launched = true;
          tracked.call.resultPreview ??= event.preview;
          if (tracked.ended) settleLaunched(tracked, tracked.ended);
          break;
        }
        if (tracked.settledByLifecycle) {
          // The launch acknowledgement can arrive after the notification; keep
          // the notification's final summary when it already provided one.
          tracked.call.resultPreview ??= event.preview;
          break;
        }
        tracked.call.resultPreview = event.preview;
        tracked.call.status = event.isError ? "error" : "ok";
        tracked.call.durationMs = elapsedMs(tracked.call.startedAt, event.at);
        break;
      }
      case "subagent": {
        // An async Agent call's tool_result arrives at launch ("async_launched");
        // the notification is the authority on how the subagent actually ended.
        const status = lifecycleStatus(event.status);
        const spawner = calls.get(event.toolUseId);
        const ends = endsLifecycle(status);
        if (spawner && ends) spawner.ended = event;
        // Traces written before the launched flag existed keep the older rule
        // below: the launch tool_result settled the call and only an ok/error
        // notification overrides it.
        const settle = spawner?.launched && ends ? spawner : null;
        if (spawner && spawner.call.category !== "agent") {
          // Background shell tasks (Bash run_in_background) report the same
          // lifecycle events. They settle the call's outcome but are not subagents.
          if (settle) settleLaunched(settle, event);
          else if (status === "ok" || status === "error") {
            spawner.call.status = status;
            spawner.settledByLifecycle = true;
            if (event.summary !== null)
              spawner.call.resultPreview = event.summary;
          }
          break;
        }
        const entry = laneFor(event.toolUseId);
        entry.lifecycle = status;
        if (event.summary !== null) entry.lane.summary = event.summary;
        if (event.toolUses !== null) entry.lane.toolUses = event.toolUses;
        if (event.durationMs !== null) entry.lane.durationMs = event.durationMs;
        if (settle) settleLaunched(settle, event);
        else if (spawner) {
          if (event.durationMs !== null)
            spawner.call.durationMs = event.durationMs;
          if (status === "ok" || status === "error") {
            spawner.call.status = status;
            spawner.settledByLifecycle = true;
          }
        }
        break;
      }
      case "result":
        outcome = foldResult(outcome, event);
        break;
      case "truncated":
        truncated = true;
        break;
    }
  }

  // A result can be followed by a continuation turn, so a live attempt is
  // running until the run ends.
  main.lane.status = runIsLive
    ? "running"
    : outcome
      ? outcome.isError
        ? "error"
        : "ok"
      : "stopped";
  main.lane.summary = outcome?.text ?? null;
  main.lane.durationMs = outcome?.durationMs ?? null;

  const subagentLanes = [...lanes.values()].filter(
    (entry) => entry.lane.id !== MAIN_LANE,
  );
  for (const { lane, lifecycle } of subagentLanes) {
    const tracked = calls.get(lane.id);
    const agent = tracked?.agent ?? null;
    lane.label =
      nonEmpty(agent?.description) ??
      nonEmpty(agent?.subagentType) ??
      "Subagent";
    lane.subagentType = agent?.subagentType ?? null;
    if (lifecycle !== null) {
      // "started" with no later notification: still running only while the run is.
      lane.status =
        lifecycle === "running" && !runIsLive ? "stopped" : lifecycle;
    } else if (
      tracked?.call.status === "ok" ||
      tracked?.call.status === "error"
    ) {
      lane.status = tracked.call.status;
    } else {
      lane.status =
        tracked?.call.status === "pending" && runIsLive ? "running" : "unknown";
    }
  }

  // Each subagent lane hangs off the call that spawned it. A lane whose spawn
  // was never captured goes under a synthetic Agent call in the lane that
  // reported the spawn's result (or main), so its activity is not dropped.
  const parentOf = new Map<string, string>();
  for (const { lane } of subagentLanes) {
    const spawner =
      calls.get(lane.id)?.laneId ??
      unmatchedResultLane.get(lane.id) ??
      MAIN_LANE;
    parentOf.set(lane.id, lanes.has(spawner) ? spawner : MAIN_LANE);
  }
  // Malformed parents could form a loop (A inside B inside A, or A inside
  // itself); cut the loop at the lane that closes it and hang that lane off
  // main instead.
  const detached = new Set<string>();
  for (const { lane } of subagentLanes) {
    const seen = new Set([lane.id]);
    let current = lane.id;
    for (;;) {
      const parent = parentOf.get(current) ?? MAIN_LANE;
      if (parent === MAIN_LANE) break;
      if (seen.has(parent)) {
        parentOf.set(current, MAIN_LANE);
        detached.add(current);
        break;
      }
      seen.add(parent);
      current = parent;
    }
  }
  for (const { lane } of subagentLanes) {
    const tracked = calls.get(lane.id);
    if (tracked && !detached.has(lane.id)) {
      tracked.call.subagent = lane;
      continue;
    }
    const parentLane = laneFor(parentOf.get(lane.id) ?? MAIN_LANE).lane;
    const startedAt = lane.steps[0]?.startedAt ?? null;
    const synthetic: RunGraphCall = {
      id: tracked ? `${lane.id}:detached` : lane.id,
      name: "Agent",
      ...categorizeTool("Agent"),
      summary: "Subagent (spawn not captured)",
      path: null,
      status: "unknown",
      startedAt,
      durationMs: lane.durationMs,
      resultPreview: null,
      subagent: lane,
    };
    insertChronologically(parentLane.steps, {
      id: `a${attempt}-${parentLane.id}-spawn-${lane.id}`,
      startedAt,
      narration: null,
      calls: [synthetic],
    });
  }

  return {
    attempt,
    startedAt: startedAt ?? events[0]?.at ?? null,
    model,
    lane: main.lane,
    sections: [],
    outcome,
    truncated,
  };
}

/** Places a step before the first step that started after it (at the end when times are unknown). */
function insertChronologically(
  steps: RunGraphStep[],
  step: RunGraphStep,
): void {
  const time = step.startedAt === null ? NaN : Date.parse(step.startedAt);
  const index = Number.isFinite(time)
    ? steps.findIndex(
        (other) =>
          other.startedAt !== null && Date.parse(other.startedAt) > time,
      )
    : -1;
  if (index === -1) steps.push(step);
  else steps.splice(index, 0, step);
}

export function buildGraphFromTrace(
  events: TraceEvent[],
  ctx: RunGraphContext,
): RunGraph {
  const byAttempt = new Map<number, TraceEvent[]>();
  for (const event of events) {
    const list = byAttempt.get(event.attempt);
    if (list) list.push(event);
    else byAttempt.set(event.attempt, [event]);
  }
  const numbers = [...byAttempt.keys()].sort((left, right) => left - right);
  const attempts = numbers.map((attempt, index) =>
    buildTraceAttempt(
      attempt,
      byAttempt.get(attempt) ?? [],
      ctx,
      index === numbers.length - 1,
    ),
  );

  const notes: string[] = [];
  if (attempts.some((attempt) => attempt.truncated)) {
    notes.push(
      `Trace was truncated at ${TRACE_MAX_EVENTS} events; later activity is not shown.`,
    );
  }
  if (ctx.kind === "agent" && events.length === 0) {
    notes.push(
      ctx.status === "running"
        ? "No agent activity has been recorded for this run yet."
        : "No agent activity was recorded for this run.",
    );
  }
  return assembleGraph(ctx, "trace", attempts, notes);
}

// ---------------------------------------------------------------------------
// From output.log (runs without a trace)

/** Daemon-written lines in output.log (see runJob in src/daemon/job-runner.ts). */
const RETRY_MARKER =
  /^=== retry (\d+)\/(\d+) \(previous attempt: ([^)]*)\) ===$/;
const TIMEOUT_MARKER = /^=== run timed out after .* ===$/;
const GIVE_UP_MARKER = /^=== giving up after .* ===$/;

/**
 * The statuses runJob retries; a marker naming any other is not trusted.
 * Daemons before 2026-08-20 (b64b580b) retried timeouts too.
 */
const RETRIED_STATUSES: readonly RunStatus[] = ["failed", "partial", "timeout"];

interface LogAttempt {
  lines: string[];
  /** How the next retry marker says this attempt ended; null for the last attempt or an unreadable marker. */
  endedAs: RunStatus | null;
}

/**
 * Splits a log into one list of lines per attempt, dropping the retry markers.
 * runJob numbers its markers 1/M, 2/M, ... under one M, so a marker that does
 * not continue that sequence, or would exceed the attempts the run recorded, is
 * tool or script output quoting another run's log and stays an ordinary line.
 */
function splitAttempts(log: string, expectedAttempts?: number): LogAttempt[] {
  const attempts: LogAttempt[] = [{ lines: [], endedAs: null }];
  let maxRetries: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const retry = RETRY_MARKER.exec(line);
    const retryNumber = retry ? Number(retry[1]) : NaN;
    const retryMax = retry ? Number(retry[2]) : NaN;
    const continues =
      retry !== null &&
      retryNumber === attempts.length &&
      retryNumber <= retryMax &&
      (maxRetries === null || retryMax === maxRetries) &&
      (expectedAttempts === undefined || attempts.length < expectedAttempts);
    if (continues) {
      maxRetries = retryMax;
      attempts[attempts.length - 1].endedAs =
        RETRIED_STATUSES.find((status) => status === retry[3]) ?? null;
      attempts.push({ lines: [], endedAs: null });
    } else {
      attempts[attempts.length - 1].lines.push(line);
    }
  }
  return attempts;
}

/** A retried attempt's outcome: the retry marker records only its status. */
function retriedOutcome(endedAs: RunStatus | null): RunGraphOutcome | null {
  if (endedAs === null) return null;
  return {
    isError: true,
    subtype: endedAs,
    durationMs: null,
    numTurns: null,
    costUsd: null,
    permissionDenials: 0,
    text: null,
  };
}

/**
 * The detail formatToolInput (src/daemon/job-runner.ts) writes after "> [Name] ".
 * Every other tool is written as a bare "> [Name]" line.
 */
const TOOL_DETAIL_PREFIX = new Map<string, string>([
  ["Bash", "$ "],
  ["Read", "Reading "],
  ["Write", "Writing "],
  ["Edit", "Editing "],
  ["Glob", "Glob: "],
  ["Grep", "Grep: "],
  ["Skill", "Skill: "],
  ["Agent", "Agent: "],
]);
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const TOOL_LINE = /^> \[([^\]\s]+)\](?: (.*))?$/;

/**
 * Parses a tool line exactly as the daemon writes it, so text that merely
 * looks similar (a quoted "> [x] done" checklist item) is not counted.
 */
function parseToolLine(
  line: string,
): { name: string; summary: string; path: string | null } | null {
  const match = TOOL_LINE.exec(line);
  if (!match) return null;
  const name = match[1];
  const detail = match[2];
  if (detail === undefined) return { name, summary: "", path: null };
  const prefix = TOOL_DETAIL_PREFIX.get(name);
  if (prefix === undefined || !detail.startsWith(prefix)) return null;
  if (name === "Bash") return { name, summary: detail, path: null };
  const rest = detail.slice(prefix.length);
  return { name, summary: rest, path: FILE_TOOLS.has(name) ? rest : null };
}

/** null is a retried attempt whose marker was unreadable; it still did not succeed. */
function logLaneStatus(status: RunStatus | null): RunGraphLaneStatus {
  switch (status) {
    case "success":
      return "ok";
    case "running":
      return "running";
    case "timeout":
      return "stopped";
    default:
      return "error";
  }
}

export function buildGraphFromAgentLog(
  log: string,
  ctx: RunGraphContext,
): RunGraph {
  const chunks = splitAttempts(log, ctx.expectedAttempts);
  let callCount = 0;
  const attempts = chunks.map(({ lines, endedAs }, index): RunGraphAttempt => {
    const attempt = index + 1;
    const isLastAttempt = index === chunks.length - 1;
    const lane = newLane(MAIN_LANE, MAIN_LANE_LABEL);
    // Earlier attempts were retried: their marker says how they ended.
    lane.status = logLaneStatus(isLastAttempt ? ctx.status : endedAs);
    const calls: RunGraphCall[] = [];
    for (const line of lines) {
      const tool = parseToolLine(line);
      if (!tool) continue;
      callCount += 1;
      calls.push({
        id: `log-${callCount}`,
        name: tool.name,
        ...categorizeTool(tool.name),
        summary: tool.summary,
        path: tool.path,
        status: "unknown",
        startedAt: null,
        durationMs: null,
        resultPreview: null,
        subagent: null,
      });
    }
    if (calls.length > 0) {
      lane.steps.push({
        id: `a${attempt}-${MAIN_LANE}-1`,
        startedAt: null,
        narration: null,
        calls,
      });
    }
    return {
      attempt,
      startedAt: attempt === 1 ? ctx.startedAt : null,
      model: null,
      lane,
      sections: [],
      outcome: retriedOutcome(endedAs),
      truncated: false,
    };
  });

  return assembleGraph(ctx, "log", attempts, [
    "Reconstructed from output.log: this run was recorded before run tracing existed.",
    "Tool outcomes, timings and subagent nesting were not recorded for runs before tracing, so every call's outcome is unknown.",
    "Subagent tool calls appear inline with the main agent's calls.",
  ]);
}

const SECTION_MARKER = /^=== (.+) ===$/;
const ISSUE_LINE = /\b(error|errors|failed|failure|exception|fatal)\b/i;
const FIRST_ISSUE_LIMIT = 200;

function buildSections(lines: string[], attempt: number): RunGraphSection[] {
  const sections: RunGraphSection[] = [];
  const open = (title: string): RunGraphSection => ({
    id: "",
    title,
    lineCount: 0,
    failed: false,
    issueCount: 0,
    firstIssue: null,
  });
  // Output before the first marker is kept only when it has content.
  let current = open("Output");
  let isPreamble = true;
  const close = (): void => {
    if (isPreamble && current.lineCount === 0) return;
    current.id = `a${attempt}-section-${sections.length + 1}`;
    sections.push(current);
  };
  for (const line of lines) {
    // A retry marker left here was quoted from another run's log; like the
    // daemon's other markers it is not a section title.
    if (
      TIMEOUT_MARKER.test(line) ||
      GIVE_UP_MARKER.test(line) ||
      RETRY_MARKER.test(line)
    )
      continue;
    const marker = SECTION_MARKER.exec(line);
    if (marker) {
      close();
      current = open(marker[1]);
      isPreamble = false;
      continue;
    }
    if (!line.trim()) continue;
    current.lineCount += 1;
    if (line.startsWith("FAILED")) current.failed = true;
    if (ISSUE_LINE.test(line)) {
      current.issueCount += 1;
      current.firstIssue ??= line.trim().slice(0, FIRST_ISSUE_LIMIT);
    }
  }
  close();
  return sections;
}

export function buildGraphFromScriptLog(
  log: string,
  ctx: RunGraphContext,
): RunGraph {
  const attempts = splitAttempts(log, ctx.expectedAttempts).map(
    ({ lines, endedAs }, index): RunGraphAttempt => ({
      attempt: index + 1,
      startedAt: index === 0 ? ctx.startedAt : null,
      model: null,
      lane: null,
      sections: buildSections(lines, index + 1),
      outcome: retriedOutcome(endedAs),
      truncated: false,
    }),
  );
  return assembleGraph(ctx, "script-log", attempts, [
    'Sections come from the "=== title ===" lines the script prints; output before the first one is grouped under "Output".',
    'A section is marked failed when one of its lines starts with "FAILED"; issues are lines mentioning error, failed, failure, exception or fatal.',
  ]);
}
