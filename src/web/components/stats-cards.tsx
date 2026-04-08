"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunResponse, JobResponse, HealthResponse } from "@/lib/api-client";

interface StatsCardsProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  health: HealthResponse | null;
}

export function StatsCards({ jobs, runs, health }: StatsCardsProps): React.ReactElement {
  const enabledCount = jobs.filter((j) => j.enabled).length;
  const todayRuns = runs.filter((r) => {
    const runDate = new Date(r.startedAt).toDateString();
    return runDate === new Date().toDateString();
  });
  const successCount = todayRuns.filter((r) => r.status === "success").length;
  const failedCount = todayRuns.filter((r) => r.status === "failed").length;
  const runningCount = todayRuns.filter((r) => r.status === "running").length;
  const activeRun = runs.find((r) => r.status === "running");

  return (
    <div className="grid grid-cols-4 gap-3">
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
          <CardTitle className="text-xs font-medium text-muted-foreground">Active Run</CardTitle>
        </CardHeader>
        <CardContent>
          {activeRun ? (
            <>
              <div className="text-xl font-semibold text-yellow-500">{activeRun.jobName}</div>
              <p className="text-xs text-muted-foreground mt-1">Running...</p>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-muted-foreground">None</div>
              <p className="text-xs text-muted-foreground mt-1">All idle</p>
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
