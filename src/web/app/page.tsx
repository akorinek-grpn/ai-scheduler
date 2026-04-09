"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatsCards } from "@/components/stats-cards";
import { RunsTable } from "@/components/runs-table";
import { JobCard } from "@/components/job-card";
import { AiInsights } from "@/components/ai-insights";
import {
  getHealth,
  getJobs,
  getRuns,
  type HealthResponse,
  type JobResponse,
  type RunResponse,
} from "@/lib/api-client";

export default function DashboardPage(): React.ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);

  const fetchAll = useCallback(async () => {
    try {
      const [h, j, r] = await Promise.all([
        getHealth().catch(() => null),
        getJobs().catch(() => []),
        getRuns({ limit: 50 }).catch(() => []),
      ]);
      setHealth(h);
      setJobs(j);
      setRuns(r);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const getJobRuns = (jobId: string): RunResponse[] => {
    return runs.filter((r) => r.jobId === jobId).slice(0, 10);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your scheduled AI runs
        </p>
      </div>

      <StatsCards jobs={jobs} runs={runs} health={health} />

      <AiInsights runs={runs} />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          <RunsTable runs={runs} limit={10} />
        </CardContent>
      </Card>

      <div>
        <h2 className="text-sm font-semibold mb-3">Jobs</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              recentRuns={getJobRuns(job.id)}
              onTrigger={fetchAll}
            />
          ))}
          {jobs.length === 0 && (
            <p className="text-sm text-muted-foreground col-span-3 text-center py-8">
              No jobs configured. Add jobs to scheduler.yaml.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
