/**
 * Compact, normalized record of what a Claude run did: one JSON object per line
 * in data/runs/<job-id>/<run-id>/trace.jsonl. The daemon appends events while
 * the run streams (so a live run can be visualized) and the run graph builder
 * reads them back. Text fields are truncated at capture time; output.log stays
 * the full human-readable log. Script runs have no trace file.
 */
export const TRACE_FORMAT_VERSION = 1;

/** Max characters kept for assistant text, the final result text and subagent summaries. */
export const TRACE_TEXT_LIMIT = 600;
/** Max characters kept for a tool call's one-line input summary. */
export const TRACE_SUMMARY_LIMIT = 300;
/** Max characters kept for a tool result preview. */
export const TRACE_PREVIEW_LIMIT = 300;
/** Events written per run (all attempts). Past this a single "truncated" event is written and the rest dropped. */
export const TRACE_MAX_EVENTS = 20_000;

interface TraceEventBase {
  /** ISO time: the CLI's own event timestamp when it sends one, otherwise when the daemon read the line. */
  at: string;
  /** 1-based attempt number. Retries of one run share a single trace file. */
  attempt: number;
}

/** First event of every attempt, written before the CLI is spawned. */
export interface TraceAttemptEvent extends TraceEventBase {
  kind: "attempt";
  version: typeof TRACE_FORMAT_VERSION;
}

/** From the CLI's `system`/`init` event. */
export interface TraceSessionEvent extends TraceEventBase {
  kind: "session";
  model: string | null;
  cliVersion: string | null;
}

/**
 * An assistant text block. `parent` is the id of the Agent/Task tool_use that
 * spawned the subagent producing it, or null for the main agent.
 */
export interface TraceTextEvent extends TraceEventBase {
  kind: "text";
  parent: string | null;
  /** Anthropic message id; blocks of one assistant message share it. Null if the CLI omits it. */
  messageId: string | null;
  text: string;
}

export interface TraceToolUseEvent extends TraceEventBase {
  kind: "tool_use";
  parent: string | null;
  messageId: string | null;
  /** tool_use id, e.g. "toolu_01...". */
  id: string;
  /** Raw tool name, e.g. "Bash", "Read", "Agent", "mcp__atlassian__jira_get_issue". */
  name: string;
  /** One-line human summary of the input, e.g. "$ npm test", "src/a.ts", "count words". */
  summary: string;
  /** file_path / notebook_path for file tools, otherwise null. */
  path: string | null;
  /** Set for subagent-spawning calls (Agent, or Task on older CLIs); null otherwise. */
  agent: { description: string | null; subagentType: string | null } | null;
}

export interface TraceToolResultEvent extends TraceEventBase {
  kind: "tool_result";
  parent: string | null;
  /** The tool_use id this result answers. */
  id: string;
  isError: boolean;
  preview: string;
  /**
   * The result only acknowledges a background launch (async Agent: tool_use_result.isAsync;
   * Bash run_in_background: tool_use_result.backgroundTaskId), so it says nothing about how
   * the work ended; a later "subagent" lifecycle event does. Absent in older traces.
   */
  launched?: boolean;
}

/**
 * Subagent lifecycle from the CLI's `system` task_started / task_notification
 * events. Background (async) agents return their tool_result immediately, so
 * this is the only record of when and how they actually finished.
 */
export interface TraceSubagentEvent extends TraceEventBase {
  kind: "subagent";
  /** The Agent tool_use id that spawned the subagent. */
  toolUseId: string;
  /** "started" for task_started; otherwise the notification's status, e.g. "completed", "failed". */
  status: string;
  summary: string | null;
  toolUses: number | null;
  durationMs: number | null;
}

/** From the CLI's final `result` event. */
export interface TraceResultEvent extends TraceEventBase {
  kind: "result";
  isError: boolean;
  subtype: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  permissionDenials: number;
  text: string | null;
}

/** Written once when TRACE_MAX_EVENTS is reached; every later event is dropped. */
export interface TraceTruncatedEvent extends TraceEventBase {
  kind: "truncated";
}

export type TraceEvent =
  | TraceAttemptEvent
  | TraceSessionEvent
  | TraceTextEvent
  | TraceToolUseEvent
  | TraceToolResultEvent
  | TraceSubagentEvent
  | TraceResultEvent
  | TraceTruncatedEvent;
