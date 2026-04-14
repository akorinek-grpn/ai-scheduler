"use client";

import { useMemo, Fragment } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
}

function StatusBadge({ status }: { status: RunResponse["status"] }): React.ReactElement {
  const variants: Record<string, { className: string; label: string }> = {
    running: { className: "border-yellow-500/50 text-yellow-500", label: "running" },
    success: { className: "border-green-500/50 text-green-500", label: "success" },
    failed: { className: "border-red-500/50 text-red-500", label: "failed" },
    timeout: { className: "border-orange-500/50 text-orange-500", label: "timeout" },
  };
  const v = variants[status] ?? variants.failed;

  return (
    <Badge variant="outline" className={v.className}>
      {status === "running" && (
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />
      )}
      {status === "success" && <span className="mr-1">{"\u2713"}</span>}
      {status === "failed" && <span className="mr-1">{"\u2717"}</span>}
      {status === "timeout" && <span className="mr-1">{"\u23F1"}</span>}
      {v.label}
    </Badge>
  );
}

const evalStyles: Record<string, { badge: string; row: string }> = {
  ok: {
    badge: "border-green-500/30 text-green-400 bg-green-500/5",
    row: "border-l-green-500/40",
  },
  info: {
    badge: "border-blue-500/30 text-blue-400 bg-blue-500/5",
    row: "border-l-blue-500/40",
  },
  warning: {
    badge: "border-amber-500/30 text-amber-400 bg-amber-500/5",
    row: "border-l-amber-500/40",
  },
  critical: {
    badge: "border-red-500/30 text-red-400 bg-red-500/5",
    row: "border-l-red-500/40",
  },
};

function EvalCell({ evaluation }: { evaluation?: RunEvaluation }): React.ReactElement | null {
  if (!evaluation) return null;

  const style = evalStyles[evaluation.severity] ?? evalStyles.info;
  const icons: Record<string, string> = {
    ok: "\u2713",
    info: "\u2139",
    warning: "\u26A0",
    critical: "!!",
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={`text-[10px] ${style.badge}`}>
          {icons[evaluation.severity] ?? "?"} {evaluation.severity}
        </Badge>
        {evaluation.followUpNeeded && (
          <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400 bg-amber-500/5">
            follow-up
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
        {evaluation.summary}
      </p>
      {evaluation.followUpReason && (
        <p className="text-[10px] text-muted-foreground/60 leading-relaxed line-clamp-1">
          {evaluation.followUpReason}
        </p>
      )}
    </div>
  );
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const BATCH_WINDOW_MS = 5 * 60 * 1000;

function groupIntoBatches(runs: RunResponse[]): RunBatch[] {
  if (runs.length === 0) return [];

  const sorted = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const batches: RunBatch[] = [];
  let currentRuns: RunResponse[] = [sorted[0]];
  let batchAnchor = new Date(sorted[0].startedAt).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const runTime = new Date(sorted[i].startedAt).getTime();
    if (batchAnchor - runTime <= BATCH_WINDOW_MS) {
      currentRuns.push(sorted[i]);
    } else {
      batches.push(makeBatch(currentRuns, batchAnchor));
      currentRuns = [sorted[i]];
      batchAnchor = runTime;
    }
  }
  batches.push(makeBatch(currentRuns, batchAnchor));

  return batches;
}

function makeBatch(runs: RunResponse[], anchorTime: number): RunBatch {
  const date = new Date(anchorTime);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let dayLabel: string;
  if (date.toDateString() === today.toDateString()) {
    dayLabel = "Today";
  } else if (date.toDateString() === yesterday.toDateString()) {
    dayLabel = "Yesterday";
  } else {
    dayLabel = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  const statusCounts: Record<string, number> = {};
  for (const r of runs) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }

  return {
    label: `${dayLabel} at ${time}`,
    runs,
    statusCounts,
  };
}

const statusDotColors: Record<string, string> = {
  success: "bg-green-500",
  failed: "bg-red-500",
  timeout: "bg-orange-500",
  running: "bg-yellow-500 animate-pulse",
};

function RunRow({ run }: { run: RunResponse }): React.ReactElement {
  const rowBorder = run.evaluation
    ? evalStyles[run.evaluation.severity]?.row ?? ""
    : "";
  return (
    <TableRow
      className={rowBorder ? `border-l-2 ${rowBorder}` : ""}
    >
      <TableCell>
        <StatusBadge status={run.status} />
      </TableCell>
      <TableCell>
        <div className="font-medium">{run.jobName}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {run.directory.split("/").pop()}
        </div>
      </TableCell>
      <TableCell>
        {run.evaluation ? (
          <EvalCell evaluation={run.evaluation} />
        ) : run.status === "running" ? (
          <span className="text-xs text-muted-foreground italic">evaluating after run...</span>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-muted-foreground">
          {run.trigger}
        </Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatTime(run.startedAt)}
      </TableCell>
      <TableCell className="font-mono text-sm text-muted-foreground">
        {formatDuration(run.startedAt, run.finishedAt)}
      </TableCell>
      <TableCell>
        <Link href={`/runs/${run.jobId}/${run.runId}`}>
          <Button variant="outline" size="sm" className="text-xs">
            {run.status === "running" ? "Watch" : "Logs"}
          </Button>
        </Link>
      </TableCell>
    </TableRow>
  );
}

export function RunsTable({ runs, limit, grouped = false }: RunsTableProps): React.ReactElement {
  const displayRuns = limit ? runs.slice(0, limit) : runs;

  const batches = useMemo(
    () => (grouped ? groupIntoBatches(displayRuns) : []),
    [displayRuns, grouped]
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Status</TableHead>
          <TableHead className="w-[140px]">Job</TableHead>
          <TableHead>AI Evaluation</TableHead>
          <TableHead className="w-[70px]">Trigger</TableHead>
          <TableHead className="w-[120px]">Started</TableHead>
          <TableHead className="w-[80px]">Duration</TableHead>
          <TableHead className="w-[60px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {grouped ? (
          batches.map((batch, batchIdx) => (
            <Fragment key={batch.label + batchIdx}>
              {/* Batch divider row */}
              <tr>
                <td colSpan={7} className={batchIdx === 0 ? "pt-0 pb-0" : "pt-4 pb-0"}>
                  <div className="flex items-center gap-3 py-1.5">
                    <span className="text-xs font-semibold text-muted-foreground tracking-wide uppercase">
                      {batch.label}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {["running", "failed", "timeout", "success"]
                        .filter((s) => batch.statusCounts[s])
                        .map((s) => (
                          <span key={s} className="flex items-center gap-1">
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDotColors[s]}`} />
                            <span className="text-[10px] text-muted-foreground/70">{batch.statusCounts[s]}</span>
                          </span>
                        ))}
                    </span>
                    <div className="flex-1 border-t border-border/50" />
                  </div>
                </td>
              </tr>
              {batch.runs.map((run) => (
                <RunRow key={`${run.jobId}-${run.runId}`} run={run} />
              ))}
            </Fragment>
          ))
        ) : (
          displayRuns.map((run) => (
            <RunRow key={`${run.jobId}-${run.runId}`} run={run} />
          ))
        )}
        {displayRuns.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
              No runs yet
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
