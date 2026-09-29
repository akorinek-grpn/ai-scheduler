"use client";

import React, { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Info } from "lucide-react";
import type { RunGraph } from "../../../shared/run-graph-types";
import {
  FILE_LIST_WINDOW,
  SOURCE_LABELS,
  categoryBreakdown,
  countLabel,
  displayPath,
  elapsedMs,
  focusRevealedItem,
  formatDurationMs,
  listFiles,
  splitPath,
  windowList,
} from "../../lib/run-diagram";
import { CategoryBreakdown } from "./category";
import { AttemptFlow } from "./flow";
import { TONE_TEXT } from "./status";

function SummaryStrip({
  graph,
  now,
}: {
  graph: RunGraph;
  now: number;
}): React.ReactElement {
  const totals = graph.totals;
  const running = graph.status === "running";
  // A finished run without finishedAt has no known duration (never "until now").
  const duration =
    running || graph.finishedAt
      ? formatDurationMs(
          elapsedMs(graph.startedAt, running ? null : graph.finishedAt, now),
        )
      : null;
  const items: Array<{ key: string; text: string; className?: string }> = [];
  if (graph.kind === "script") {
    const sections = graph.attempts.flatMap((attempt) => attempt.sections);
    const failed = sections.filter((section) => section.failed).length;
    const issues = sections.reduce(
      (sum, section) => sum + section.issueCount,
      0,
    );
    items.push({
      key: "sections",
      text: countLabel(sections.length, "section"),
    });
    items.push({
      key: "failed",
      text: `${failed} failed`,
      className: failed > 0 ? `font-medium ${TONE_TEXT.error}` : undefined,
    });
    items.push({
      key: "issues",
      text: countLabel(issues, "issue"),
      className: issues > 0 ? TONE_TEXT.warning : undefined,
    });
  } else {
    items.push({
      key: "calls",
      text: countLabel(totals.toolCalls, "tool call"),
    });
    items.push({ key: "steps", text: countLabel(totals.steps, "step") });
    if (graph.source === "log") {
      // output.log records neither call outcomes nor subagent nesting, so zero
      // errors or subagents would be claims the log cannot support.
      const agentCalls = totals.byCategory?.agent ?? 0;
      if (agentCalls > 0)
        items.push({
          key: "agent-calls",
          text: countLabel(agentCalls, "agent call"),
        });
      items.push({ key: "outcomes", text: "outcomes not recorded" });
    } else {
      items.push({
        key: "subagents",
        text: countLabel(totals.subagents, "subagent"),
      });
      items.push({
        key: "errors",
        text: countLabel(totals.errors, "error"),
        className:
          totals.errors > 0 ? `font-medium ${TONE_TEXT.error}` : undefined,
      });
    }
  }
  if (duration)
    items.push({
      key: "duration",
      text: running ? `${duration} elapsed` : duration,
    });
  return (
    <ul
      aria-label="Diagram summary"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground"
    >
      <li className="font-medium text-foreground">
        {SOURCE_LABELS[graph.source] ?? graph.source}
      </li>
      {items.map((item) => (
        <li key={item.key} className={`tabular-nums ${item.className ?? ""}`}>
          {item.text}
        </li>
      ))}
    </ul>
  );
}

function Notes({ notes }: { notes: string[] }): React.ReactElement {
  return (
    <div
      role="note"
      className="flex gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground"
    >
      <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        {notes.map((note, index) => (
          <p key={index} className="break-words">
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}

function FilesDisclosure({
  filesRead,
  filesChanged,
  directory,
}: {
  filesRead: string[];
  filesChanged: string[];
  directory: string | null;
}): React.ReactElement | null {
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const entries = listFiles(filesRead, filesChanged);
  if (entries.length === 0) return null;
  // Count the rows, not the raw totals: a file read and then edited is listed once, as changed.
  const changed = entries.filter((entry) => entry.change === "changed").length;
  const visible = windowList(entries.length, FILE_LIST_WINDOW, showAll);
  const revealAll = (): void => {
    flushSync(() => setShowAll(true));
    focusRevealedItem(listRef.current, visible.headEnd);
  };
  return (
    <details className="rounded border border-border bg-card">
      <summary className="min-h-8 cursor-pointer rounded px-3 py-1.5 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {`Files · ${entries.length - changed} read · ${changed} changed`}
      </summary>
      <ul ref={listRef} className="space-y-px px-3 pb-2 font-mono text-[11px]">
        {entries.slice(0, visible.headEnd).map((entry) => {
          const { dir, base } = splitPath(displayPath(entry.path, directory));
          return (
            <li key={entry.path} className="flex min-w-0 items-baseline gap-2">
              <span
                className={`w-14 shrink-0 font-sans text-[10px] uppercase tracking-wider ${entry.change === "changed" ? "text-foreground" : "text-muted-foreground"}`}
              >
                {entry.change}
              </span>
              <span className="flex min-w-0" title={entry.path}>
                {dir && (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {dir}
                  </span>
                )}
                <span className="max-w-full shrink-0 truncate">{base}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {visible.hidden > 0 && (
        <button
          type="button"
          onClick={revealAll}
          className="mb-2 ml-2 inline-flex min-h-[24px] items-center rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {`Show all ${entries.length} files`}
        </button>
      )}
    </details>
  );
}

export interface RunDiagramViewProps {
  graph: RunGraph;
  /** How the run was started ("scheduled", "manual", "catchup"), shown on the first Start node. */
  trigger?: string | null;
  /** The job's working directory; paths inside it are shown relative to it. */
  directory?: string | null;
  /** Clock for live durations; injectable for tests. */
  now?: number;
}

/** Presentational Diagram for one run graph: summary, categories, notes, files, then one flow per attempt. */
export function RunDiagramView({
  graph,
  trigger = null,
  directory = null,
  now = Date.now(),
}: RunDiagramViewProps): React.ReactElement {
  const attempts = graph.attempts;
  return (
    <div className="min-w-0 space-y-3">
      {/* Gives the attempt h3s a parent in the page outline instead of the cost section above the tabs. */}
      <h2 className="sr-only">Run diagram</h2>
      <SummaryStrip graph={graph} now={now} />
      <CategoryBreakdown shares={categoryBreakdown(graph.totals.byCategory)} />
      {graph.notes.length > 0 && <Notes notes={graph.notes} />}
      <FilesDisclosure
        filesRead={graph.totals.filesRead}
        filesChanged={graph.totals.filesChanged}
        directory={directory}
      />
      <div className="space-y-5 rounded border border-border bg-card p-3">
        {attempts.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No attempts were recorded for this run.
          </p>
        ) : (
          attempts.map((attempt, index) => (
            <AttemptFlow
              key={attempt.attempt}
              attempt={attempt}
              isLast={index === attempts.length - 1}
              showHeader={attempts.length > 1}
              graph={graph}
              trigger={trigger}
              directory={directory}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
