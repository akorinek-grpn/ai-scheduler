"use client";

import { useMemo, Fragment } from "react";
import Link from "next/link";
import type { RunResponse, RunEvaluation } from "@/lib/api-client";

interface RunsTableProps {
  runs: RunResponse[];
  limit?: number;
  grouped?: boolean;
}

interface RunBatch {
  label: string;
  runs: RunResponse[];
  statusCounts: Record<string, number>;
  hasIssues: boolean;
}

// --- Status visuals ---

const statusDot: Record<string, string> = {
  running: "bg-yellow-500 animate-pulse",
  success: "bg-green-500",
  partial: "bg-amber-500",
  failed: "bg-red-500",
  timeout: "bg-orange-500",
};

const statusText: Record<string, string> = {
  running: "text-yellow-500",
  success: "text-green-500",
  partial: "text-amber-500",
  failed: "text-red-500",
  timeout: "text-orange-500",
};

const evalColor: Record<string, string> = {
  ok: "text-muted-foreground",
  info: "text-blue-500",
  warning: "text-amber-500",
  critical: "text-red-500",
};

const evalIcon: Record<string, string> = {
  ok: "\u2713",
  info: "\u2139",
  warning: "\u26A0",
  critical: "!!",
};

// --- Formatting ---

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem > 0 ? ` ${rem}s` : ""}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// --- Batching ---

const BATCH_WINDOW_MS = 5 * 60 * 1000;

function groupIntoBatches(runs: RunResponse[]): RunBatch[] {
  if (runs.length === 0) return [];

  const sorted = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const batches: RunBatch[] = [];
  let currentRuns: RunResponse[] = [sorted[0]];
  let anchor = new Date(sorted[0].startedAt).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const t = new Date(sorted[i].startedAt).getTime();
    if (anchor - t <= BATCH_WINDOW_MS) {
      currentRuns.push(sorted[i]);
    } else {
      batches.push(makeBatch(currentRuns, anchor));
      currentRuns = [sorted[i]];
      anchor = t;
    }
  }
  batches.push(makeBatch(currentRuns, anchor));
  return batches;
}

function makeBatch(runs: RunResponse[], anchorTime: number): RunBatch {
  const date = new Date(anchorTime);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let day: string;
  if (date.toDateString() === today.toDateString()) day = "Today";
  else if (date.toDateString() === yesterday.toDateString()) day = "Yesterday";
  else day = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const statusCounts: Record<string, number> = {};
  let hasIssues = false;
  for (const r of runs) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    if (r.status === "failed" || r.status === "timeout" || r.status === "partial") hasIssues = true;
    if (r.evaluation?.severity === "critical" || r.evaluation?.severity === "warning") hasIssues = true;
  }

  return { label: `${day} ${time}`, runs, statusCounts, hasIssues };
}

// --- Run Row (single-line, compact) ---

function RunRow({ run }: { run: RunResponse }): React.ReactElement {
  const ev = run.evaluation;
  const isBad = run.status === "failed" || run.status === "timeout";
  const isPartial = run.status === "partial";
  const evIsBad = ev && (ev.severity === "critical" || ev.severity === "warning");

  return (
    <Link
      href={`/runs/${run.jobId}/${run.runId}`}
      className={`
        flex items-center gap-3 px-3 py-1.5 rounded transition-colors
        hover:bg-secondary/60
        ${isBad || evIsBad ? "bg-red-500/[0.03]" : isPartial ? "bg-amber-500/[0.04]" : ""}
      `}
    >
      {/* Status dot */}
      <span className={`h-2 w-2 rounded-full shrink-0 ${statusDot[run.status] ?? "bg-muted-foreground/50"}`} />

      {/* Job name */}
      <span className={`text-[13px] w-[180px] truncate shrink-0 ${isBad || isPartial ? "font-medium" : ""} ${isBad ? "text-red-500" : isPartial ? "text-amber-500" : ""}`}>
        {run.jobName}
      </span>

      {/* Eval one-liner */}
      <span className="flex-1 min-w-0 truncate text-[12px]">
        {ev ? (
          <span className={evalColor[ev.severity] ?? "text-muted-foreground"}>
            <span className="font-medium">{evalIcon[ev.severity]}</span>
            {" "}
            {ev.summary}
            {ev.followUpNeeded && <span className="text-amber-500 ml-1">*</span>}
          </span>
        ) : run.status === "running" ? (
          <span className="text-muted-foreground">running...</span>
        ) : (
          <span className="text-muted-foreground">{"\u2014"}</span>
        )}
      </span>

      {/* Trigger */}
      {run.trigger === "manual" && (
        <span className="text-[10px] text-muted-foreground shrink-0">manual</span>
      )}

      {/* Duration */}
      <span className="text-[12px] font-mono text-muted-foreground tabular-nums w-[52px] text-right shrink-0">
        {formatDuration(run.startedAt, run.finishedAt)}
      </span>

      {/* Time */}
      <span className="text-[12px] font-mono text-muted-foreground tabular-nums w-[72px] text-right shrink-0">
        {formatTime(run.startedAt)}
      </span>
    </Link>
  );
}

// --- Main Component ---

export function RunsTable({ runs, limit, grouped = false }: RunsTableProps): React.ReactElement {
  const displayRuns = limit ? runs.slice(0, limit) : runs;

  const batches = useMemo(
    () => (grouped ? groupIntoBatches(displayRuns) : []),
    [displayRuns, grouped]
  );

  if (displayRuns.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-[13px]">
        No runs yet
      </div>
    );
  }

  if (!grouped) {
    return (
      <div className="space-y-px">
        {displayRuns.map((run) => (
          <RunRow key={`${run.jobId}-${run.runId}`} run={run} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {batches.map((batch, idx) => (
        <div key={batch.label + idx}>
          {/* Batch header */}
          <div className="flex items-center gap-2 px-3 mb-0.5">
            <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
              {batch.label}
            </span>
            <span className="flex items-center gap-1.5">
              {(["failed", "timeout", "partial", "running", "success"] as const)
                .filter((s) => batch.statusCounts[s])
                .map((s) => (
                  <span key={s} className="flex items-center gap-0.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot[s]}`} />
                    <span className="text-[10px] text-muted-foreground tabular-nums">{batch.statusCounts[s]}</span>
                  </span>
                ))}
            </span>
            {batch.hasIssues && (
              <span className="text-[10px] text-red-500">issues</span>
            )}
            <div className="flex-1 border-t border-border/50" />
          </div>

          {/* Runs */}
          <div className="space-y-px">
            {batch.runs.map((run) => (
              <RunRow key={`${run.jobId}-${run.runId}`} run={run} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
