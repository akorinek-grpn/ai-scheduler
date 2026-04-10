"use client";

import { Card, CardContent } from "@/components/ui/card";
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

const severityStyles: Record<string, { text: string; bg: string; border: string; panelBg: string }> = {
  ok: { text: "text-green-400", bg: "bg-green-500", border: "border-green-500/30", panelBg: "bg-green-500/5" },
  info: { text: "text-blue-400", bg: "bg-blue-500", border: "border-blue-500/30", panelBg: "bg-blue-500/5" },
  warning: { text: "text-amber-400", bg: "bg-amber-500", border: "border-amber-500/30", panelBg: "bg-amber-500/5" },
  critical: { text: "text-red-400", bg: "bg-red-500", border: "border-red-500/30", panelBg: "bg-red-500/5" },
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
  const lastRunStatus = lastRun?.status;
  const statusColor = lastRunStatus === "success"
    ? "bg-green-500"
    : lastRunStatus === "failed"
      ? "bg-red-500"
      : lastRunStatus === "running"
        ? "bg-yellow-500"
        : lastRunStatus === "timeout"
          ? "bg-orange-500"
          : "bg-zinc-500";

  // Success rate from recent runs
  const completedRuns = recentRuns.filter((r) => r.status !== "running");
  const successRuns = completedRuns.filter((r) => r.status === "success");
  const successRate = completedRuns.length > 0
    ? Math.round((successRuns.length / completedRuns.length) * 100)
    : null;

  // Latest evaluation
  const lastEval = recentRuns.find((r) => r.evaluation)?.evaluation;

  return (
    <Card className={!job.enabled ? "opacity-50" : ""}>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold truncate pr-2">{job.name}</span>
          <div className="flex items-center gap-2 shrink-0">
            {lastRunStatus === "running" && (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            )}
            <div className={`h-2 w-2 rounded-full ${statusColor}`} />
          </div>
        </div>

        <div className="text-xs text-muted-foreground font-mono mb-1 truncate">
          {job.directory.split("/").pop()}
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          {formatCronHuman(job.schedule)}
          {!job.enabled && " · disabled"}
          {job.model && ` · ${job.model}`}
        </div>

        {/* Evaluation summary */}
        {lastEval && (
          <div className={`rounded-md px-2.5 py-2 mb-3 border ${
            severityStyles[lastEval.severity]?.border ?? "border-border"
          } ${severityStyles[lastEval.severity]?.panelBg ?? ""}`}>
            <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 ${severityStyles[lastEval.severity]?.text ?? ""}`}
              >
                {lastEval.severity}
              </Badge>
              {lastEval.followUpNeeded && (
                <span className="text-[10px] text-amber-400">follow-up</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
              {lastEval.summary}
            </p>
          </div>
        )}

        {/* Run history dots */}
        {recentRuns.length > 0 && (
          <div className="mb-3">
            <RunHistoryDots runs={recentRuns} count={3} />
          </div>
        )}

        {/* Footer with toggle, run, and success rate */}
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className={`text-xs ${job.enabled ? "text-muted-foreground" : "text-green-400"}`}
            onClick={handleToggle}
            disabled={isToggling || job.isActive}
          >
            {isToggling ? "..." : job.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="sm"
            className="text-xs"
            onClick={handleTrigger}
            disabled={isTriggering || job.isActive || !job.enabled}
          >
            {isTriggering ? "Starting..." : "Run now"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {successRate !== null && (
              <span className={`text-xs font-medium ${
                successRate >= 80 ? "text-green-500" : successRate >= 50 ? "text-amber-500" : "text-red-500"
              }`}>
                {successRate}% pass
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
