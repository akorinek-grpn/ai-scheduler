"use client";

import Link from "next/link";
import type { RunResponse } from "@/lib/api-client";

interface RunHistoryDotsProps {
  runs: RunResponse[];
  count?: number;
}

const statusColors: Record<string, string> = {
  success: "bg-green-500/80 hover:bg-green-500 border-green-500/40",
  partial: "bg-amber-500/80 hover:bg-amber-500 border-amber-500/40",
  failed: "bg-red-500/80 hover:bg-red-500 border-red-500/40",
  timeout: "bg-orange-500/80 hover:bg-orange-500 border-orange-500/40",
  running: "bg-yellow-500/80 hover:bg-yellow-500 border-yellow-500/40 animate-pulse",
};

const statusIcons: Record<string, string> = {
  success: "\u2713",
  partial: "\u26A0",
  failed: "\u2717",
  timeout: "\u23F1",
  running: "\u25CF",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function RunHistoryDots({ runs, count = 3 }: RunHistoryDotsProps): React.ReactElement {
  // Most recent first; pad with empty slots if fewer than count
  const displayRuns = runs.slice(0, count);
  const emptySlots = Math.max(0, count - displayRuns.length);

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground mr-1">last {count}:</span>
      {displayRuns.map((run) => (
        <Link
          key={`${run.jobId}-${run.runId}`}
          href={`/runs/${run.jobId}/${run.runId}`}
          title={`${run.status} \u2014 ${formatTime(run.startedAt)}`}
          className={`flex h-4 w-4 items-center justify-center rounded border text-[8px] text-white transition-colors ${
            statusColors[run.status] ?? "bg-muted-foreground border-muted-foreground/50"
          }`}
        >
          {statusIcons[run.status] ?? "?"}
        </Link>
      ))}
      {Array.from({ length: emptySlots }).map((_, i) => (
        <span
          key={`empty-${i}`}
          className="flex h-4 w-4 items-center justify-center rounded border border-dashed border-border text-[8px] text-muted-foreground"
          title="no run"
        >
          {"\u00B7"}
        </span>
      ))}
    </div>
  );
}
