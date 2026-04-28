"use client";

import type {
  RunResponse,
  JobResponse,
  HealthResponse,
  CatchupQueueSnapshot,
} from "@/lib/api-client";

interface StatsCardsProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  health: HealthResponse | null;
  catchups?: CatchupQueueSnapshot | null;
}

export function StatsCards({ jobs, runs, health, catchups }: StatsCardsProps): React.ReactElement {
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const todayRuns = runs.filter((r) => {
    return new Date(r.startedAt).toDateString() === new Date().toDateString();
  });
  const successCount = todayRuns.filter((r) => r.status === "success").length;
  const partialCount = todayRuns.filter((r) => r.status === "partial").length;
  const failedCount = todayRuns.filter((r) => r.status === "failed").length;
  const runningCount = todayRuns.filter((r) => r.status === "running").length;
  const followUpCount = runs.filter((r) => r.evaluation?.followUpNeeded).length;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-border bg-card px-4 py-3" role="region" aria-label="Run statistics">
      {/* Daemon status */}
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${health ? "bg-green-500" : "bg-muted-foreground/50"}`} />
        <span className="text-[13px] font-medium">
          {health ? "Online" : "Offline"}
        </span>
      </div>

      <span className="text-border">|</span>

      {/* Jobs */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[13px] font-mono font-semibold tabular-nums">{enabledCount}</span>
        <span className="text-[12px] text-muted-foreground">jobs active</span>
        {jobs.length - enabledCount > 0 && (
          <span className="text-[11px] text-muted-foreground">({jobs.length - enabledCount} off)</span>
        )}
      </div>

      <span className="text-border">|</span>

      {/* Today's runs */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[13px] font-mono font-semibold tabular-nums">{todayRuns.length}</span>
        <span className="text-[12px] text-muted-foreground">runs today</span>
        <span className="flex items-center gap-1.5 ml-1">
          {successCount > 0 && <span className="text-[12px] text-green-500 tabular-nums">{successCount} ok</span>}
          {partialCount > 0 && <span className="text-[12px] text-amber-500 tabular-nums">{partialCount} partial</span>}
          {failedCount > 0 && <span className="text-[12px] text-red-500 tabular-nums">{failedCount} fail</span>}
          {runningCount > 0 && <span className="text-[12px] text-yellow-500 tabular-nums">{runningCount} running</span>}
        </span>
      </div>

      {/* Follow-ups */}
      {followUpCount > 0 && (
        <>
          <span className="text-border">|</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-mono font-semibold text-amber-500 tabular-nums">{followUpCount}</span>
            <span className="text-[12px] text-amber-500/80">need follow-up</span>
          </div>
        </>
      )}

      {/* Catch-ups queued */}
      {catchups && (catchups.queued.length > 0 || catchups.inFlight) && (
        <>
          <span className="text-border">|</span>
          <div className="flex items-baseline gap-1.5" aria-label="Catch-up queue">
            <span className="text-[13px] font-mono font-semibold text-blue-500 tabular-nums">
              {catchups.queued.length}
            </span>
            <span className="text-[12px] text-blue-500/80">
              ↻ catch-ups queued
            </span>
            {catchups.inFlight && (
              <span className="text-[11px] text-blue-500/70 ml-1">
                · running: {catchups.inFlight.jobName}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
