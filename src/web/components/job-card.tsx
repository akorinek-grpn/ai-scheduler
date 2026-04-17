"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunHistoryDots } from "@/components/run-history-dots";
import type { JobResponse, RunResponse } from "@/lib/api-client";
import { triggerJob, setJobEnabled } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";
import { useState } from "react";

interface JobCardProps {
  job: JobResponse;
  recentRuns: RunResponse[];
  onTrigger: () => void;
}

const severityText: Record<string, string> = {
  ok: "text-green-500",
  info: "text-blue-500",
  warning: "text-amber-500",
  critical: "text-red-500",
};

const severityBg: Record<string, string> = {
  ok: "",
  info: "",
  warning: "bg-amber-500/[0.04]",
  critical: "bg-red-500/[0.05]",
};

export function JobCard({ job, recentRuns, onTrigger }: JobCardProps): React.ReactElement {
  const [isTriggering, setIsTriggering] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  const handleTrigger = async () => {
    setIsTriggering(true);
    try {
      await triggerJob(job.id);
      onTrigger();
    } catch (err) {
      console.error("Failed to trigger job:", err);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleToggle = async () => {
    setIsToggling(true);
    try {
      await setJobEnabled(job.id, !job.enabled);
      onTrigger();
    } catch (err) {
      console.error("Failed to toggle job:", err);
    } finally {
      setIsToggling(false);
    }
  };

  const lastRun = recentRuns[0];
  const statusColor = lastRun?.status === "success"
    ? "bg-green-500"
    : lastRun?.status === "partial"
      ? "bg-amber-500"
      : lastRun?.status === "failed"
        ? "bg-red-500"
        : lastRun?.status === "running"
          ? "bg-yellow-500"
          : lastRun?.status === "timeout"
            ? "bg-orange-500"
            : "bg-muted-foreground/50";

  const completedRuns = recentRuns.filter((r) => r.status !== "running");
  const successRuns = completedRuns.filter((r) => r.status === "success");
  const successRate = completedRuns.length > 0
    ? Math.round((successRuns.length / completedRuns.length) * 100)
    : null;

  const lastEval = recentRuns.find((r) => r.evaluation)?.evaluation;

  return (
    <div className={`rounded border border-border p-3 transition-colors hover:bg-secondary/30 ${!job.enabled ? "opacity-60" : ""}`}>
      {/* Header: name + status dot */}
      <div className="flex items-center gap-2 mb-1">
        <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusColor}`} />
        <span className="text-[13px] font-medium truncate">{job.name}</span>
        {successRate !== null && (
          <span className={`text-[11px] font-mono tabular-nums ml-auto shrink-0 ${
            successRate >= 80 ? "text-green-500" : successRate >= 50 ? "text-amber-500" : "text-red-500"
          }`}>
            {successRate}%
          </span>
        )}
      </div>

      {/* Meta line */}
      <div className="text-[11px] text-muted-foreground mb-2 truncate">
        <span className="font-mono">{job.directory.split("/").pop()}</span>
        <span className="mx-1.5 text-border">/</span>
        <span>{formatCronHuman(job.schedule)}</span>
        {job.model && <span className="ml-1.5 text-muted-foreground">{job.model}</span>}
      </div>

      {/* Eval summary (compact) */}
      {lastEval && (
        <div className={`rounded px-2 py-1.5 mb-2 ${severityBg[lastEval.severity] ?? ""}`}>
          <p className={`text-[11px] leading-relaxed line-clamp-2 ${severityText[lastEval.severity] ?? "text-muted-foreground"}`}>
            {lastEval.severity !== "ok" && <span className="font-medium">{lastEval.severity}: </span>}
            {lastEval.summary}
          </p>
        </div>
      )}

      {/* Run history + actions */}
      <div className="flex items-center gap-2 pt-1.5 border-t border-border/50">
        {recentRuns.length > 0 && (
          <RunHistoryDots runs={recentRuns} count={3} />
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] h-6 px-1.5 text-muted-foreground"
            onClick={handleToggle}
            disabled={isToggling || job.isActive}
          >
            {isToggling ? "..." : job.enabled ? "Off" : "On"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-[11px] h-6 px-2"
            onClick={handleTrigger}
            disabled={isTriggering || job.isActive || !job.enabled}
          >
            {isTriggering ? "..." : "Run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
