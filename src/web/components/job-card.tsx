"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { JobResponse, RunResponse } from "@/lib/api-client";
import { triggerJob } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";
import { useState } from "react";

interface JobCardProps {
  job: JobResponse;
  lastRun?: RunResponse;
  onTrigger: () => void;
}

export function JobCard({ job, lastRun, onTrigger }: JobCardProps): React.ReactElement {
  const [isTriggering, setIsTriggering] = useState(false);

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

  const lastRunStatus = lastRun?.status;
  const statusColor = lastRunStatus === "success"
    ? "bg-green-500"
    : lastRunStatus === "failed"
      ? "bg-red-500"
      : lastRunStatus === "running"
        ? "bg-yellow-500"
        : "bg-zinc-500";

  return (
    <Card className={!job.enabled ? "opacity-50" : ""}>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold">{job.name}</span>
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
        </div>
        <div className="text-xs text-muted-foreground font-mono mb-1">
          {job.directory.split("/").pop()}
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          {formatCronHuman(job.schedule)}
          {!job.enabled && " · disabled"}
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            className="text-xs"
            onClick={handleTrigger}
            disabled={isTriggering || job.isActive}
          >
            {isTriggering ? "Starting..." : "Run now"}
          </Button>
          {lastRun && (
            <span className="ml-auto text-[11px] text-zinc-500">
              Last: {lastRunStatus === "success" ? "✓" : lastRunStatus === "failed" ? "✗" : "..."}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
