import fs from "fs";
import os from "os";
import path from "path";
import { traceEventsFromStreamLine } from "./run-trace";
import { extractTextFromStreamJson } from "./stream-text";
import { TRACE_FORMAT_VERSION, TRACE_MAX_EVENTS } from "@shared/run-trace-types";
import { priceUsage } from "@shared/model-prices";
import type { CostEntry, ModelCost } from "@shared/cost-types";

/**
 * Inner Claude sessions of script runs. A script job such as autopilot's run-babysit.sh or
 * run-daily.sh starts `claude -p --session-id <id>` itself, so the run's own output.log only
 * carries the script's status lines; the work (the b2c-toolkit flow, its skills and tool
 * calls) is in that session's transcript, ~/.claude/projects/<dir>/<id>.jsonl, on the Mac
 * that ran it. Ingesting copies what the run page needs into the run directory, which also
 * makes it travel with host sync:
 *   session.log   - text, one line per tool call, clipped results (a claude job's log format)
 *   trace.jsonl   - the trace behind the Diagram view (the outcome only once the run is final)
 *   sessions.json - one entry per session: id, cwd, transcript path, times, counts
 * Every write rebuilds the files from the transcripts, which only grow, so session.log only
 * ever gains text at its end and the log viewer's byte offsets stay valid while it runs.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** "session <id>", "session-id <id>", "--session-id <id>", "session_id=<id>". */
const SESSION_MENTION = new RegExp(`\\bsession(?:[ _-]?id)?[\\s:="']+(${UUID})`, "gi");
/** output.log is read up to here when looking for session ids. */
const LOG_SCAN_BYTES = 2 * 1024 * 1024;

/** Token usage of one model inside a session, summed over its API calls (sidechains included). */
export interface SessionModelUsage {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of cacheWriteTokens, those written with the 1-hour TTL (priced higher). */
  cacheWrite1hTokens: number;
  /** List-price USD (shared/model-prices.ts), or null when the model is not listed. */
  costUsd: number | null;
}

export interface InnerSession {
  id: string;
  cwd: string | null;
  transcript: string;
  startedAt: string | null;
  lastAt: string | null;
  turns: number;
  toolCalls: number;
  /** Per model, from the transcript's API usage (since 2026-10-16; absent on older sessions.json). */
  usage?: SessionModelUsage[];
  /** Sum of usage costs, or null when any model is unpriced. */
  costUsd?: number | null;
}

interface TranscriptUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
}

const int = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * Adds one API call's usage to the per-model tally. A transcript writes one line per content block
 * of a response, each repeating the response's usage, so callers dedupe by message id first.
 */
function addUsage(tally: Map<string, SessionModelUsage>, model: string, usage: TranscriptUsage): void {
  const entry =
    tally.get(model) ??
    {
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      costUsd: null,
    };
  const cacheWrite = int(usage.cache_creation_input_tokens);
  const cacheWrite1h = Math.min(cacheWrite, int(usage.cache_creation?.ephemeral_1h_input_tokens));
  entry.calls += 1;
  entry.inputTokens += int(usage.input_tokens);
  entry.outputTokens += int(usage.output_tokens);
  entry.cacheReadTokens += int(usage.cache_read_input_tokens);
  entry.cacheWriteTokens += cacheWrite;
  entry.cacheWrite1hTokens += cacheWrite1h;
  tally.set(model, entry);
}

function priceTally(tally: Map<string, SessionModelUsage>): SessionModelUsage[] {
  return [...tally.values()].map((entry) => ({
    ...entry,
    costUsd: priceUsage(entry.model, {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens - entry.cacheWrite1hTokens,
      cacheWrite1hTokens: entry.cacheWrite1hTokens,
    }),
  }));
}

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

function sessionCost(usage: SessionModelUsage[]): number | null {
  if (usage.length === 0 || usage.some((entry) => entry.costUsd === null)) return null;
  return round(usage.reduce((total, entry) => total + (entry.costUsd ?? 0), 0));
}

/**
 * The run's execution cost entries, one per inner session, in the shape claude-mode runs record
 * from `claude -p`'s result event. Tokens are exact; dollars are list prices, null when a model
 * is unlisted. Sessions without any API usage (a transcript still being written) give no entry.
 */
export function sessionCostEntries(sessions: InnerSession[]): CostEntry[] {
  const entries: CostEntry[] = [];
  for (const session of sessions) {
    const usage = session.usage ?? [];
    if (usage.length === 0) continue;
    const models: ModelCost[] = usage.map((entry) => ({
      model: entry.model,
      costUsd: entry.costUsd === null ? null : round(entry.costUsd),
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
    }));
    entries.push({
      id: `session:${session.id}`,
      label: `Claude session ${session.id.slice(0, 8)} (list price from the transcript's token usage)`,
      source: "claude",
      costUsd: session.costUsd ?? sessionCost(usage),
      tokens: models.reduce(
        (total, model) => ({
          inputTokens: total.inputTokens + model.inputTokens,
          outputTokens: total.outputTokens + model.outputTokens,
          cacheReadTokens: total.cacheReadTokens + model.cacheReadTokens,
          cacheWriteTokens: total.cacheWriteTokens + model.cacheWriteTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ),
      models,
    });
  }
  return entries;
}

export function findSessionIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(SESSION_MENTION)) {
    const id = match[1]!.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** The transcript file of a session, in any project directory, or null. */
export function findTranscript(sessionId: string, projectsDir: string): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readHead(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Writes through a temp file so a reader never sees a half-written file. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

interface TranscriptEntry {
  type?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  isSidechain?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: unknown; content?: unknown };
}

/**
 * Rebuilds session.log, trace.jsonl and sessions.json in `runDir` from the inner sessions its
 * output.log names. `final` adds each session's outcome to the trace; leave it false while the
 * run is live. Returns the sessions found; writes nothing when there are none. Best effort:
 * callers catch, a failure must never fail the run.
 */
export function ingestInnerSessions(
  runDir: string,
  options: { projectsDir?: string; final: boolean },
): InnerSession[] {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const ids = findSessionIds(readHead(path.join(runDir, "output.log"), LOG_SCAN_BYTES));
  if (ids.length === 0) return [];

  const sessions: InnerSession[] = [];
  const text: string[] = [];
  const trace: string[] = [];
  let traceEvents = 0;
  let truncated = false;
  const pushTrace = (event: object): void => {
    if (truncated) return;
    if (traceEvents >= TRACE_MAX_EVENTS) {
      truncated = true;
      trace.push(JSON.stringify({ kind: "truncated", attempt: 1, at: new Date().toISOString() }));
      return;
    }
    traceEvents += 1;
    trace.push(JSON.stringify(event));
  };

  for (const id of ids) {
    const transcript = findTranscript(id, projectsDir);
    if (!transcript) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(transcript, "utf8");
    } catch {
      continue;
    }
    const session: InnerSession = { id, cwd: null, transcript, startedAt: null, lastAt: null, turns: 0, toolCalls: 0 };
    let lastText: string | null = null;
    const body: string[] = [];
    const tally = new Map<string, SessionModelUsage>();
    const pricedMessages = new Set<string>();

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue; // a line still being written
      }
      // Every API call costs money, subagents' included: tally usage before the sidechain skip.
      // One response is logged once per content block, each line repeating its usage.
      if (entry.type === "assistant" && typeof entry.message?.model === "string" && entry.message.usage && typeof entry.message.usage === "object") {
        const messageId = typeof entry.message.id === "string" ? entry.message.id : null;
        if (messageId === null || !pricedMessages.has(messageId)) {
          if (messageId !== null) pricedMessages.add(messageId);
          addUsage(tally, entry.message.model, entry.message.usage as TranscriptUsage);
        }
      }
      // Subagent work belongs to its own thread; the main thread's Agent call stands for it.
      if (entry.isSidechain === true) continue;
      if (entry.type !== "assistant" && entry.type !== "user") continue;
      const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
      if (typeof entry.cwd === "string") session.cwd ??= entry.cwd;
      if (at) {
        session.startedAt ??= at;
        session.lastAt = at;
      }
      if (entry.type === "assistant") {
        session.turns += 1;
        const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
        for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
          if (block?.type === "tool_use") session.toolCalls += 1;
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) lastText = block.text;
        }
      }
      const readable = extractTextFromStreamJson(line);
      if (readable) body.push(readable);
      if (trace.length === 0) pushTrace({ kind: "attempt", version: TRACE_FORMAT_VERSION, attempt: 1, at: at ?? new Date().toISOString() });
      for (const event of traceEventsFromStreamLine(line, 1, () => at ?? new Date().toISOString())) pushTrace(event);
    }

    if (session.startedAt === null && session.turns === 0) continue;
    session.usage = priceTally(tally);
    session.costUsd = sessionCost(session.usage);
    // The separator goes before a later session, never after the last one, so a growing
    // session only ever adds text at the very end.
    text.push(
      `${sessions.length > 0 ? "\n\n" : ""}=== Claude session ${id}${session.cwd ? ` in ${session.cwd}` : ""} ===\n`,
      ...body,
    );
    if (options.final) {
      const durationMs =
        session.startedAt && session.lastAt ? Date.parse(session.lastAt) - Date.parse(session.startedAt) : null;
      const outcome = JSON.stringify({
        type: "result",
        timestamp: session.lastAt ?? undefined,
        result: lastText ?? "",
        is_error: false,
        num_turns: session.turns,
        duration_ms: durationMs,
      });
      for (const event of traceEventsFromStreamLine(outcome, 1, () => session.lastAt ?? new Date().toISOString())) pushTrace(event);
    }
    sessions.push(session);
  }

  if (sessions.length === 0) return [];
  writeAtomic(path.join(runDir, "session.log"), text.join(""));
  writeAtomic(path.join(runDir, "trace.jsonl"), trace.join("\n") + "\n");
  writeAtomic(path.join(runDir, "sessions.json"), JSON.stringify(sessions, null, 2));
  return sessions;
}
