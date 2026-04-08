"use client";

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
      {status === "success" && <span className="mr-1">✓</span>}
      {status === "failed" && <span className="mr-1">✗</span>}
      {status === "timeout" && <span className="mr-1">⏱</span>}
      {v.label}
    </Badge>
  );
}

function EvalBadge({ evaluation }: { evaluation?: RunEvaluation }): React.ReactElement | null {
  if (!evaluation) return null;

  const styles: Record<string, string> = {
    ok: "border-green-500/30 text-green-400 bg-green-500/5",
    info: "border-blue-500/30 text-blue-400 bg-blue-500/5",
    warning: "border-amber-500/30 text-amber-400 bg-amber-500/5",
    critical: "border-red-500/30 text-red-400 bg-red-500/5",
  };

  const icons: Record<string, string> = {
    ok: "✓",
    info: "ℹ",
    warning: "⚠",
    critical: "!!",
  };

  return (
    <span title={evaluation.summary + (evaluation.followUpReason ? `\n\nFollow-up: ${evaluation.followUpReason}` : "")}>
      <Badge variant="outline" className={styles[evaluation.severity] ?? styles.info}>
        {icons[evaluation.severity] ?? "?"}{" "}
        {evaluation.followUpNeeded ? "needs follow-up" : evaluation.severity}
      </Badge>
    </span>
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

export function RunsTable({ runs, limit }: RunsTableProps): React.ReactElement {
  const displayRuns = limit ? runs.slice(0, limit) : runs;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">Status</TableHead>
          <TableHead>Job</TableHead>
          <TableHead>Evaluation</TableHead>
          <TableHead className="w-[70px]">Trigger</TableHead>
          <TableHead className="w-[120px]">Started</TableHead>
          <TableHead className="w-[80px]">Duration</TableHead>
          <TableHead className="w-[60px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {displayRuns.map((run) => (
          <TableRow key={`${run.jobId}-${run.runId}`}>
            <TableCell>
              <StatusBadge status={run.status} />
            </TableCell>
            <TableCell>
              <div className="font-medium">{run.jobName}</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {run.directory.split("/").pop()}
              </div>
            </TableCell>
            <TableCell>
              {run.evaluation ? (
                <div>
                  <EvalBadge evaluation={run.evaluation} />
                  <div className="text-[11px] text-muted-foreground mt-1 max-w-xs truncate">
                    {run.evaluation.summary}
                  </div>
                </div>
              ) : run.status === "running" ? (
                <span className="text-xs text-muted-foreground">pending...</span>
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
        ))}
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
