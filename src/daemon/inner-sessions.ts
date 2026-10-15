import fs from "fs";
import os from "os";
import path from "path";
import { traceEventsFromStreamLine } from "./run-trace";
import { extractTextFromStreamJson } from "./stream-text";
import { TRACE_FORMAT_VERSION, TRACE_MAX_EVENTS } from "@shared/run-trace-types";

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

export interface InnerSession {
  id: string;
  cwd: string | null;
  transcript: string;
  startedAt: string | null;
  lastAt: string | null;
  turns: number;
  toolCalls: number;
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
  message?: { content?: unknown };
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

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue; // a line still being written
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
