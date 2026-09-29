import fs from "fs";
import {
  TRACE_FORMAT_VERSION,
  TRACE_MAX_EVENTS,
  TRACE_PREVIEW_LIMIT,
  TRACE_SUMMARY_LIMIT,
  TRACE_TEXT_LIMIT,
  type TraceEvent,
} from "@shared/run-trace-types";

// Maps the Claude CLI's `--output-format stream-json` events to the compact
// TraceEvent records in trace.jsonl. The CLI format is external and changes
// between versions, so every field is type-checked and anything unexpected is
// skipped rather than trusted.

type JsonObject = Record<string, unknown>;

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Cuts `text` to at most `limit` chars, ending with "…" when anything was
 * dropped. `cut` says text was already dropped before `text` (so it is marked
 * even when `text` itself fits).
 */
function clip(text: string, limit: number, cut = false): string {
  if (!cut && text.length <= limit) return text;
  let end = Math.min(text.length, limit - 1);
  // Don't split a surrogate pair (emoji etc.) into a lone half.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + "…";
}

/**
 * Normalizes `text` and clips it to `limit` chars. Tool inputs and results can
 * be megabytes, and this runs synchronously in the daemon's stdout handler, so
 * only a prefix a few times the limit is normalized (normalizing can shrink
 * text, e.g. by collapsing indentation); anything past it is marked as cut.
 */
function clipNormalized(
  text: string,
  limit: number,
  normalize: (text: string) => string,
): string {
  const scan = limit * 4;
  if (text.length <= scan) return clip(normalize(text), limit);
  return clip(normalize(text.slice(0, scan)), limit, true);
}

/** Joins the lines of `text` with single spaces, trimming each line. Linear: no backtracking. */
function oneLine(text: string): string {
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function eventTime(event: JsonObject, now: () => string): string {
  const ts = event.timestamp;
  return typeof ts === "string" &&
    ISO_TIME.test(ts) &&
    !Number.isNaN(Date.parse(ts))
    ? ts
    : now();
}

function toolPath(input: JsonObject): string | null {
  return nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path);
}

function specificSummary(name: string, input: JsonObject): string | null {
  switch (name) {
    case "Bash": {
      const command = nonEmpty(input.command)?.trim();
      if (!command) return null;
      const newline = command.indexOf("\n");
      if (newline < 0) return `$ ${command}`;
      return `$ ${command.slice(0, newline).trim()} …`;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return toolPath(input);
    case "Glob":
    case "Grep": {
      const pattern = nonEmpty(input.pattern);
      if (!pattern) return null;
      const where = nonEmpty(input.path);
      return where ? `${pattern} in ${where}` : pattern;
    }
    case "Skill":
      return nonEmpty(input.skill);
    case "Agent":
    case "Task":
      return nonEmpty(input.description);
    case "WebFetch":
      return nonEmpty(input.url);
    case "WebSearch":
      return nonEmpty(input.query);
    case "TaskCreate":
      return nonEmpty(input.subject);
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : null;
    default:
      return null;
  }
}

/** Compact JSON of a tool input, or a placeholder when it is nested too deeply for the recursive JSON.stringify. */
function compactJson(input: JsonObject): string {
  try {
    return JSON.stringify(input);
  } catch {
    return "{…}";
  }
}

function toolSummary(name: string, input: JsonObject): string {
  let summary = specificSummary(name, input);
  if (summary === null) {
    const firstString = Object.values(input).find(
      (value): value is string => nonEmpty(value) !== null,
    );
    summary = firstString ?? compactJson(input);
  }
  return clipNormalized(summary, TRACE_SUMMARY_LIMIT, oneLine);
}

/** Set on a tool_result that only acknowledges a background launch (async Agent, Bash run_in_background). */
function launchFlag(event: JsonObject): { launched: true } | null {
  const result = event.tool_use_result;
  return isObject(result) &&
    (result.isAsync === true || typeof result.backgroundTaskId === "string")
    ? { launched: true }
    : null;
}

function resultPreview(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string")
        parts.push(block.text);
      else if (block.type === "image") parts.push("[image]");
    }
    text = parts.join(" ");
  }
  return clipNormalized(text, TRACE_PREVIEW_LIMIT, collapseWhitespace);
}

function assistantEvents(
  event: JsonObject,
  attempt: number,
  at: string,
): TraceEvent[] {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  const parent = str(event.parent_tool_use_id);
  const messageId = str(message.id);
  const out: TraceEvent[] = [];
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type === "text") {
      const text = nonEmpty(block.text);
      if (text) {
        out.push({
          kind: "text",
          at,
          attempt,
          parent,
          messageId,
          text: clip(text.trim(), TRACE_TEXT_LIMIT),
        });
      }
    } else if (block.type === "tool_use") {
      const id = nonEmpty(block.id);
      const name = nonEmpty(block.name);
      if (!id || !name) continue;
      const input = isObject(block.input) ? block.input : {};
      out.push({
        kind: "tool_use",
        at,
        attempt,
        parent,
        messageId,
        id,
        name,
        summary: toolSummary(name, input),
        path: toolPath(input),
        agent:
          name === "Agent" || name === "Task"
            ? {
                description: nonEmpty(input.description),
                subagentType: nonEmpty(input.subagent_type),
              }
            : null,
      });
    }
  }
  return out;
}

function userEvents(
  event: JsonObject,
  attempt: number,
  at: string,
): TraceEvent[] {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  const parent = str(event.parent_tool_use_id);
  const launched = launchFlag(event);
  const out: TraceEvent[] = [];
  for (const block of message.content) {
    if (!isObject(block) || block.type !== "tool_result") continue;
    const id = nonEmpty(block.tool_use_id);
    if (!id) continue;
    out.push({
      kind: "tool_result",
      at,
      attempt,
      parent,
      id,
      isError: block.is_error === true,
      preview: resultPreview(block.content),
      ...launched,
    });
  }
  return out;
}

/**
 * Maps one stream-json line to 0..n trace events. Pure: invalid or partial
 * JSON and event types the diagram doesn't use (hooks, thinking, rate limits,
 * task progress...) yield []. `now` stamps events that carry no timestamp.
 */
export function traceEventsFromStreamLine(
  line: string,
  attempt: number,
  now: () => string,
): TraceEvent[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(event)) return [];
  const at = eventTime(event, now);

  switch (event.type) {
    case "assistant":
      return assistantEvents(event, attempt, at);
    case "user":
      return userEvents(event, attempt, at);
    case "system": {
      if (event.subtype === "init") {
        return [
          {
            kind: "session",
            at,
            attempt,
            model: str(event.model),
            cliVersion: str(event.claude_code_version),
          },
        ];
      }
      if (
        event.subtype !== "task_started" &&
        event.subtype !== "task_notification"
      ) {
        return [];
      }
      const toolUseId = nonEmpty(event.tool_use_id);
      if (!toolUseId) return [];
      if (event.subtype === "task_started") {
        return [
          {
            kind: "subagent",
            at,
            attempt,
            toolUseId,
            status: "started",
            summary: null,
            toolUses: null,
            durationMs: null,
          },
        ];
      }
      const usage = isObject(event.usage) ? event.usage : {};
      const summary = nonEmpty(event.summary);
      return [
        {
          kind: "subagent",
          at,
          attempt,
          toolUseId,
          status: nonEmpty(event.status) ?? "unknown",
          summary: summary ? clip(summary.trim(), TRACE_TEXT_LIMIT) : null,
          toolUses: num(usage.tool_uses),
          durationMs: num(usage.duration_ms),
        },
      ];
    }
    case "result": {
      const text = nonEmpty(event.result);
      return [
        {
          kind: "result",
          at,
          attempt,
          isError: event.is_error === true,
          subtype: str(event.subtype),
          durationMs: num(event.duration_ms),
          numTurns: num(event.num_turns),
          costUsd: num(event.total_cost_usd),
          permissionDenials: Array.isArray(event.permission_denials)
            ? event.permission_denials.length
            : 0,
          text: text ? clip(text.trim(), TRACE_TEXT_LIMIT) : null,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Appends a run's trace events to trace.jsonl while the run streams, so the
 * Diagram view can follow a live run. Tracing is best effort: a write failure,
 * or any error while mapping a line, is logged once and turns the writer into
 * a no-op instead of failing the run. No method throws.
 */
export class RunTraceWriter {
  private stream: fs.WriteStream | null = null;
  private attempt = 1;
  private written = 0;
  private truncated = false;
  private failed = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly tracePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    try {
      this.stream = fs.createWriteStream(tracePath, { flags: "a" });
      this.stream.on("error", (err) => this.fail(err));
    } catch (err) {
      this.fail(err);
    }
  }

  /** Writes the attempt marker; events consumed afterwards belong to `attempt`. */
  startAttempt(attempt: number): void {
    try {
      this.attempt = attempt;
      this.append({
        kind: "attempt",
        version: TRACE_FORMAT_VERSION,
        attempt,
        at: this.now(),
      });
    } catch (err) {
      this.fail(err);
    }
  }

  /** Maps one stream-json line and appends its events to the current attempt. */
  consume(line: string): void {
    if (this.failed || this.truncated || this.closing) return;
    try {
      for (const event of traceEventsFromStreamLine(
        line,
        this.attempt,
        this.now,
      )) {
        this.append(event);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** Flushes and closes the file, keeping what was written before any failure. Resolves even if writing failed. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = new Promise<void>((resolve) => {
        const stream = this.stream;
        // A stream that errored is already destroyed; one left open by a
        // mapping error still needs ending so its fd is released.
        if (!stream || stream.destroyed) {
          resolve();
          return;
        }
        // 'close' follows 'finish' once the fd is closed; 'error' ends the stream too.
        stream.once("close", () => resolve());
        stream.once("error", () => resolve());
        stream.end();
      });
    }
    return this.closing;
  }

  private append(event: TraceEvent): void {
    if (!this.stream || this.failed || this.truncated || this.closing) return;
    try {
      if (this.written >= TRACE_MAX_EVENTS) {
        this.truncated = true;
        event = { kind: "truncated", attempt: this.attempt, at: this.now() };
      }
      this.written += 1;
      this.stream.write(JSON.stringify(event) + "\n");
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[trace] Could not write ${this.tracePath}; tracing disabled for this run: ${reason}`,
    );
  }
}
