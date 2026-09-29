import {
  TOOL_CATEGORIES,
  type RunGraph,
  type RunGraphAttempt,
  type RunGraphCall,
  type RunGraphCallStatus,
  type RunGraphLane,
  type RunGraphLaneStatus,
  type RunGraphSource,
  type ToolCategory,
} from "../../shared/run-graph-types";

/**
 * Pure helpers for the run page's Diagram view. Everything here is derived from
 * a RunGraph so the component stays presentational and these rules stay testable.
 */

export const SOURCE_LABELS: Record<RunGraphSource, string> = {
  trace: "Traced",
  log: "Reconstructed from log",
  "script-log": "Script sections",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check for the graph endpoint's JSON before it reaches the renderer, so a
 * stale or mismatched daemon produces an error message instead of a crash.
 */
export function isRunGraph(value: unknown): value is RunGraph {
  if (!isRecord(value) || !isRecord(value.totals)) return false;
  if (value.kind !== "agent" && value.kind !== "script") return false;
  if (typeof value.status !== "string" || typeof value.startedAt !== "string")
    return false;
  if (
    !Array.isArray(value.notes) ||
    !Array.isArray(value.totals.filesRead) ||
    !Array.isArray(value.totals.filesChanged)
  )
    return false;
  return (
    Array.isArray(value.attempts) &&
    value.attempts.every(
      (attempt) =>
        isRecord(attempt) &&
        Array.isArray(attempt.sections) &&
        (attempt.lane === null ||
          (isRecord(attempt.lane) && Array.isArray(attempt.lane.steps))),
    )
  );
}

/** "1 tool call", "3 tool calls". */
export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// --- Call grouping ---

/**
 * A rendered row inside a step: one call, or a run of consecutive look-alike
 * calls. Keys are prefixed by kind ("c:" / "g:") so a single row and a group row
 * never share a React key.
 */
export type CallRow =
  | { kind: "call"; key: string; call: RunGraphCall }
  | { kind: "group"; key: string; name: string; calls: RunGraphCall[] };

/** Failures must stay visible, and subagent calls carry their own lane, so neither folds into a group. */
function isStandalone(call: RunGraphCall): boolean {
  return call.status === "error" || call.subagent !== null;
}

/**
 * Folds consecutive calls that share a tool name into one group row, whatever
 * their ok / pending / unknown status. Grouping ignores those statuses so that a
 * live poll in which some parallel calls have answered keeps the same rows and
 * keys, and an expanded group stays expanded.
 */
export function groupCalls(calls: readonly RunGraphCall[]): CallRow[] {
  const rows: CallRow[] = [];
  let run: RunGraphCall[] = [];
  const flush = (): void => {
    if (run.length === 1) {
      rows.push({ kind: "call", key: `c:${run[0].id}`, call: run[0] });
    } else if (run.length > 1) {
      rows.push({
        kind: "group",
        key: `g:${run[0].id}`,
        name: run[0].name,
        calls: run,
      });
    }
    run = [];
  };
  for (const call of calls) {
    if (isStandalone(call)) {
      flush();
      rows.push({ kind: "call", key: `c:${call.id}`, call });
      continue;
    }
    if (run.length > 0 && run[0].name !== call.name) flush();
    run.push(call);
  }
  flush();
  return rows;
}

// --- Windowing (keeps large runs fast: nothing renders thousands of nodes up front) ---

export interface WindowPolicy {
  /** Lists at or under this length are shown whole. */
  limit: number;
  /** Items shown from the start of a longer list. */
  head: number;
  /** Items shown from the end of a longer list. */
  tail: number;
}

/** Lanes with more than 40 steps show the first 20 and the last 10. */
export const LANE_STEP_WINDOW: WindowPolicy = { limit: 40, head: 20, tail: 10 };
/** Steps with more than 12 rows show the first 8. */
export const STEP_ROW_WINDOW: WindowPolicy = { limit: 12, head: 8, tail: 0 };
/** The files disclosure lists 10 paths before "show all" once there are more than 12. */
export const FILE_LIST_WINDOW: WindowPolicy = { limit: 12, head: 10, tail: 0 };

/** Items [0, headEnd) and [tailStart, length) are shown; `hidden` items between sit behind a button. */
export interface ListWindow {
  headEnd: number;
  tailStart: number;
  hidden: number;
}

export function windowList(
  length: number,
  policy: WindowPolicy,
  expanded: boolean,
): ListWindow {
  const size = Math.max(0, Math.floor(length));
  if (expanded || size <= policy.limit)
    return { headEnd: size, tailStart: size, hidden: 0 };
  const tailStart = size - policy.tail;
  return { headEnd: policy.head, tailStart, hidden: tailStart - policy.head };
}

// --- Lane counts ---

/** Error calls in a lane and, recursively, in every subagent lane nested inside it. */
export function countLaneErrors(lane: RunGraphLane): number {
  let errors = 0;
  for (const step of lane.steps) {
    for (const call of step.calls) {
      if (call.status === "error") errors += 1;
      if (call.subagent) errors += countLaneErrors(call.subagent);
    }
  }
  return errors;
}

/** Calls captured directly in a lane (not counting nested subagent lanes). */
export function countLaneCalls(lane: RunGraphLane): number {
  return lane.steps.reduce((total, step) => total + step.calls.length, 0);
}

// --- Status display ---

/**
 * How a call or subagent status is drawn. "live" = still in progress while the
 * run is running; "no-result" = started but never answered and the run is over.
 */
export type StatusDisplay =
  "ok" | "error" | "live" | "no-result" | "stopped" | "none";

export function callStatusDisplay(
  status: RunGraphCallStatus,
  runIsLive: boolean,
): StatusDisplay {
  switch (status) {
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "pending":
      return runIsLive ? "live" : "no-result";
    default:
      return "none";
  }
}

export interface GroupStatus {
  display: StatusDisplay;
  /** Calls still waiting for a result, when only some of the group's calls are; null otherwise. */
  pendingCount: number | null;
}

/**
 * A group row's status. Pending calls win (live while the run runs, else no
 * result), with their count when the group also holds answered calls; a check
 * only when every call succeeded; nothing when some outcomes are unknown.
 */
export function groupStatus(
  calls: readonly RunGraphCall[],
  runIsLive: boolean,
): GroupStatus {
  const pending = calls.filter((call) => call.status === "pending").length;
  if (pending > 0)
    return {
      display: callStatusDisplay("pending", runIsLive),
      pendingCount: pending < calls.length ? pending : null,
    };
  const allOk = calls.length > 0 && calls.every((call) => call.status === "ok");
  return { display: allOk ? "ok" : "none", pendingCount: null };
}

/** A subagent's status: its lane lifecycle, unless the spawning call itself failed. */
export function subagentStatusDisplay(
  laneStatus: RunGraphLaneStatus,
  callStatus: RunGraphCallStatus,
  runIsLive: boolean,
): StatusDisplay {
  if (callStatus === "error" || laneStatus === "error") return "error";
  switch (laneStatus) {
    case "ok":
      return "ok";
    case "running":
      return runIsLive ? "live" : "no-result";
    case "stopped":
      return "stopped";
    default:
      return "none";
  }
}

// --- Attempt outcome ---

export type OutcomeTone = "ok" | "error" | "warning" | "live" | "muted";

export interface OutcomeLabel {
  text: string;
  tone: OutcomeTone;
}

const RUN_STATUS_OUTCOME: Record<RunGraph["status"], OutcomeLabel> = {
  running: { text: "Running…", tone: "live" },
  success: { text: "success", tone: "ok" },
  partial: { text: "partial", tone: "warning" },
  failed: { text: "failed", tone: "error" },
  timeout: { text: "timeout", tone: "error" },
};

/**
 * The last attempt reports the run's own status (it already folds in the exit
 * code). An earlier attempt was retried, so it reports its recorded outcome by
 * subtype: the CLI's result subtype for traces ("error_max_turns" reads "error
 * max turns"), or the attempt's run status for log reconstructions ("partial").
 */
export function attemptOutcome(
  attempt: RunGraphAttempt,
  isLast: boolean,
  runStatus: RunGraph["status"],
): OutcomeLabel {
  if (isLast)
    return (
      RUN_STATUS_OUTCOME[runStatus] ?? {
        text: String(runStatus),
        tone: "muted",
      }
    );
  const outcome = attempt.outcome;
  if (!outcome) return { text: "no result · retried", tone: "warning" };
  const subtype = outcome.subtype ?? (outcome.isError ? "error" : "ok");
  const text = `${subtype.replaceAll("_", " ")} · retried`;
  const tone: OutcomeTone =
    outcome.isError && subtype !== "partial" ? "error" : "warning";
  return { text, tone };
}

/**
 * The result text for an attempt's End node, or null when there is none or it
 * only repeats the main lane's last narration (traced runs narrate their final
 * answer, which the CLI then reports again as the result).
 */
export function endResultText(
  attempt: RunGraphAttempt,
  isLast: boolean,
): string | null {
  const text =
    attempt.outcome?.text ?? (isLast ? (attempt.lane?.summary ?? null) : null);
  if (!text || !text.trim()) return null;
  const steps = attempt.lane?.steps ?? [];
  const lastNarration =
    steps.length > 0 ? steps[steps.length - 1].narration : null;
  return lastNarration?.trim() === text.trim() ? null : text;
}

// --- Formatting ---

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
}

/** "450ms", "1.5s", "12s", "1m 12s", "1h 2m"; null when the duration is unknown or invalid. */
export function formatDurationMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  return formatSeconds(Math.floor(ms / 1000));
}

function parseTime(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/** Whole-second offset of `at` from `from`, e.g. "+1m 12s". Clock skew never shows as negative. */
export function formatOffset(
  from: string | null | undefined,
  at: string | null | undefined,
): string | null {
  const start = parseTime(from);
  const end = parseTime(at);
  if (start === null || end === null) return null;
  return `+${formatSeconds(Math.max(0, Math.floor((end - start) / 1000)))}`;
}

/** Milliseconds between two ISO times; `end` null means "until now" (a live run). */
export function elapsedMs(
  start: string | null | undefined,
  end: string | null | undefined,
  now: number,
): number | null {
  const from = parseTime(start);
  const to = end == null ? now : parseTime(end);
  if (from === null || to === null) return null;
  return Math.max(0, to - from);
}

/** Sum of the known durations of a set of calls; null when none are known. */
export function sumDurations(calls: readonly RunGraphCall[]): number | null {
  let total: number | null = null;
  for (const call of calls) {
    if (
      typeof call.durationMs === "number" &&
      Number.isFinite(call.durationMs) &&
      call.durationMs >= 0
    ) {
      total = (total ?? 0) + call.durationMs;
    }
  }
  return total;
}

/**
 * Whether text might not fit in `lines` clamped lines at the narrowest supported
 * width (~50 characters per line), so a "more" toggle is worth offering.
 */
export function mayOverflow(
  text: string,
  lines: number,
  charsPerLine = 50,
): boolean {
  let visualLines = 0;
  for (const paragraph of text.split("\n")) {
    visualLines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
    if (visualLines > lines) return true;
  }
  return false;
}

// --- Categories ---

export interface CategoryShare {
  category: ToolCategory;
  count: number;
  /** Share of all counted calls, 0–100. */
  percent: number;
}

/** Categories with at least one call, in TOOL_CATEGORIES order, with their share of the total. */
export function categoryBreakdown(
  byCategory: Partial<Record<ToolCategory, number>> | null | undefined,
): CategoryShare[] {
  const counted = TOOL_CATEGORIES.map((category) => {
    const raw = byCategory?.[category];
    const count =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : 0;
    return { category, count };
  }).filter((entry) => entry.count > 0);
  const total = counted.reduce((sum, entry) => sum + entry.count, 0);
  return counted.map((entry) => ({
    ...entry,
    percent: (entry.count / total) * 100,
  }));
}

// --- Files ---

export interface FileEntry {
  path: string;
  change: "changed" | "read";
}

/** Changed files first, then files that were only read; a path appears once. */
export function listFiles(
  filesRead: readonly string[],
  filesChanged: readonly string[],
): FileEntry[] {
  const seen = new Set<string>();
  const entries: FileEntry[] = [];
  for (const path of filesChanged) {
    if (typeof path !== "string" || seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, change: "changed" });
  }
  for (const path of filesRead) {
    if (typeof path !== "string" || seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, change: "read" });
  }
  return entries;
}

/** macOS resolves /tmp, /var and /etc under /private, so a job directory and the CLI's paths may disagree on the prefix. */
function directoryAliases(directory: string): string[] {
  if (directory.startsWith("/private/")) return [directory, directory.slice(8)];
  if (/^\/(tmp|var|etc)(\/|$)/.test(directory))
    return [directory, `/private${directory}`];
  return [directory];
}

/**
 * A path or call summary as displayed: relative to the job's directory when it
 * lies inside it, else with a leading /Users/<name>/ shortened to "~/". Other
 * text is returned unchanged; callers keep the full value for the title.
 */
export function displayPath(
  value: string,
  directory: string | null | undefined,
): string {
  const root = directory?.replace(/\/+$/, "") ?? "";
  if (root) {
    for (const prefix of directoryAliases(root)) {
      if (value.startsWith(`${prefix}/`) && value.length > prefix.length + 1)
        return value.slice(prefix.length + 1);
    }
  }
  const home = /^\/Users\/[^/]+\//.exec(value);
  return home ? `~/${value.slice(home[0].length)}` : value;
}

/**
 * After a "show more" button reveals the items of `list` from `index` on (and
 * disappears), hands focus to the first revealed item so keyboard users keep
 * their place: the item's own row button when it is one, else the item itself,
 * made programmatically focusable.
 */
export function focusRevealedItem(
  list: ParentNode | null | undefined,
  index: number,
): void {
  const item = list?.children[index] as HTMLElement | undefined;
  if (!item) return;
  const first = item.firstElementChild as HTMLElement | null;
  if (first?.tagName === "BUTTON") {
    first.focus();
    return;
  }
  item.tabIndex = -1;
  item.focus();
}

/** Splits a path so the directory can truncate while the file name stays visible. */
export function splitPath(path: string): { dir: string; base: string } {
  const trimmed =
    path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: trimmed };
  return { dir: trimmed.slice(0, slash + 1), base: trimmed.slice(slash + 1) };
}
