import type { RunStatus } from "./types";

/**
 * What a run did, shaped for the run page's Diagram view. Built on demand by the
 * daemon (GET /api/runs/:jobId/:runId/graph) from trace.jsonl, or reconstructed
 * from output.log for runs that have no trace.
 */

export type ToolCategory =
  | "read"
  | "search"
  | "edit"
  | "shell"
  | "web"
  | "agent"
  | "skill"
  | "mcp"
  | "plan"
  | "other";

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  "read",
  "search",
  "edit",
  "shell",
  "web",
  "agent",
  "skill",
  "mcp",
  "plan",
  "other",
];

/**
 * - "trace": exact, from trace.jsonl.
 * - "log": best effort from output.log for Claude runs recorded before tracing existed.
 * - "script-log": script runs, split into sections from output.log.
 */
export type RunGraphSource = "trace" | "log" | "script-log";

/**
 * - "pending": started with no result yet (still running, or the run ended mid-call).
 * - "unknown": outcome was not recorded (log reconstruction).
 */
export type RunGraphCallStatus = "ok" | "error" | "pending" | "unknown";

export type RunGraphLaneStatus =
  "running" | "ok" | "error" | "stopped" | "unknown";

export interface RunGraphCall {
  /** tool_use id; synthetic ("log-<n>") for log reconstructions. */
  id: string;
  /** Raw tool name, e.g. "Bash", "mcp__atlassian__jira_get_issue". */
  name: string;
  /** Short display name, e.g. "Bash", "jira_get_issue". */
  label: string;
  /** MCP server for mcp__ tools, e.g. "atlassian"; null otherwise. */
  server: string | null;
  category: ToolCategory;
  summary: string;
  path: string | null;
  status: RunGraphCallStatus;
  startedAt: string | null;
  durationMs: number | null;
  resultPreview: string | null;
  /** The subagent this call spawned, when its activity or lifecycle was captured. */
  subagent: RunGraphLane | null;
}

/** One assistant turn: optional narration text followed by the tool calls it made. */
export interface RunGraphStep {
  id: string;
  startedAt: string | null;
  narration: string | null;
  calls: RunGraphCall[];
}

/** The main agent, or one subagent. */
export interface RunGraphLane {
  /** "main", or the spawning Agent tool_use id. */
  id: string;
  label: string;
  subagentType: string | null;
  status: RunGraphLaneStatus;
  /** Subagent's final report, or the main agent's final result text. */
  summary: string | null;
  /** Tool uses the CLI reported for a subagent (may exceed the calls captured). */
  toolUses: number | null;
  durationMs: number | null;
  steps: RunGraphStep[];
}

export interface RunGraphOutcome {
  isError: boolean;
  subtype: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  permissionDenials: number;
  text: string | null;
}

/** A block of script output that starts at an "=== title ===" line. */
export interface RunGraphSection {
  id: string;
  title: string;
  lineCount: number;
  /** A line starting with "FAILED" appeared in the section. */
  failed: boolean;
  /** Lines mentioning error / failed / exception / fatal. */
  issueCount: number;
  firstIssue: string | null;
}

export interface RunGraphAttempt {
  attempt: number;
  startedAt: string | null;
  model: string | null;
  /** Agent runs: the main agent's lane (subagents nest inside its calls). Null for script runs. */
  lane: RunGraphLane | null;
  /** Script runs: output sections. Empty for agent runs. */
  sections: RunGraphSection[];
  outcome: RunGraphOutcome | null;
  /** The trace hit TRACE_MAX_EVENTS during this attempt. */
  truncated: boolean;
}

export interface RunGraphTotals {
  toolCalls: number;
  errors: number;
  subagents: number;
  steps: number;
  byCategory: Record<ToolCategory, number>;
  /** Unique paths in first-seen order. */
  filesRead: string[];
  filesChanged: string[];
}

export interface RunGraph {
  jobId: string;
  runId: string;
  kind: "agent" | "script";
  source: RunGraphSource;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  attempts: RunGraphAttempt[];
  totals: RunGraphTotals;
  /** Limitations of this reconstruction, shown above the diagram. */
  notes: string[];
}
