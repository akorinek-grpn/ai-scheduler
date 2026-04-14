"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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

interface JobGroup {
  label: string;
  description: string;
  jobs: JobResponse[];
}

const GROUP_ORDER = ["daily", "weekly", "periodic"] as const;

const GROUP_META: Record<string, { label: string; description: string }> = {
  daily: { label: "Daily", description: "Runs every weekday" },
  weekly: { label: "Weekly", description: "Runs once or twice a week" },
  periodic: { label: "Periodic", description: "Runs on a recurring interval" },
  other: { label: "Other", description: "Uncategorized jobs" },
};

function categorizeJobs(jobs: JobResponse[]): JobGroup[] {
  const buckets: Record<string, JobResponse[]> = {};

  for (const job of jobs) {
    const category = GROUP_ORDER.find((g) => job.tags.includes(g)) ?? "other";
    if (!buckets[category]) buckets[category] = [];
    buckets[category].push(job);
  }

  const groups: JobGroup[] = [];
  for (const key of [...GROUP_ORDER, "other"]) {
    if (buckets[key]?.length) {
      const meta = GROUP_META[key];
      groups.push({ label: meta.label, description: meta.description, jobs: buckets[key] });
    }
  }
  return groups;
}

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

  const jobGroups = useMemo(() => categorizeJobs(jobs), [jobs]);

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
          <RunsTable runs={runs} limit={20} grouped />
        </CardContent>
      </Card>

      {/* Job cards grouped by category */}
      {jobGroups.map((group) => (
        <div key={group.label}>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm font-semibold">{group.label}</h2>
            <span className="text-xs text-muted-foreground">{group.description}</span>
            <div className="flex-1 border-t border-border/40" />
            <span className="text-xs text-muted-foreground">{group.jobs.length} jobs</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {group.jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                recentRuns={getJobRuns(job.id)}
                onTrigger={fetchAll}
              />
            ))}
          </div>
        </div>
      ))}
      {jobs.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No jobs configured. Add jobs to scheduler.yaml.
        </p>
      )}
    </div>
  );
}
