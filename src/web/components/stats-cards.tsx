"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunResponse, JobResponse, HealthResponse } from "@/lib/api-client";

interface StatsCardsProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  health: HealthResponse | null;
}

function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div className={`animate-pulse rounded bg-secondary ${className ?? ""}`} />;
}

export function StatsCards({ jobs, runs, health }: StatsCardsProps): React.ReactElement {
  const isLoading = jobs.length === 0 && !health;
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const todayRuns = runs.filter((r) => {
    const runDate = new Date(r.startedAt).toDateString();
    return runDate === new Date().toDateString();
  });
  const successCount = todayRuns.filter((r) => r.status === "success").length;
  const failedCount = todayRuns.filter((r) => r.status === "failed").length;
  const runningCount = todayRuns.filter((r) => r.status === "running").length;
  const activeRun = runs.find((r) => r.status === "running");
  const followUpCount = runs.filter((r) => r.evaluation?.followUpNeeded).length;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-12 mb-2" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Total Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{jobs.length}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {enabledCount} enabled · {jobs.length - enabledCount} disabled
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Runs Today</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{todayRuns.length}</div>
          <p className="text-xs mt-1">
            <span className="text-green-500">{successCount} passed</span>
            {failedCount > 0 && <> · <span className="text-red-500">{failedCount} failed</span></>}
            {runningCount > 0 && <> · <span className="text-yellow-500">{runningCount} running</span></>}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            {followUpCount > 0 ? "Needs Attention" : "Active Run"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {followUpCount > 0 ? (
            <>
              <div className="text-3xl font-bold text-amber-500">{followUpCount}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {followUpCount === 1 ? "run needs" : "runs need"} follow-up
              </p>
            </>
          ) : activeRun ? (
            <>
              <div className="text-xl font-semibold text-yellow-500 truncate">{activeRun.jobName}</div>
              <p className="text-xs text-muted-foreground mt-1">Running...</p>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-muted-foreground">All clear</div>
              <p className="text-xs text-muted-foreground mt-1">No follow-ups needed</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Daemon</CardTitle>
        </CardHeader>
        <CardContent>
          {health ? (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
                <span className="text-xl font-semibold">Online</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">PID {health.pid}</p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-zinc-500" />
                <span className="text-xl font-semibold text-muted-foreground">Offline</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Daemon not running</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
