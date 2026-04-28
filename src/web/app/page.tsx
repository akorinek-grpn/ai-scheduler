"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { StatsCards } from "@/components/stats-cards";
import { RunsTable } from "@/components/runs-table";
import { JobCard } from "@/components/job-card";
import { AiInsights } from "@/components/ai-insights";
import { LifetimeActivity } from "@/components/lifetime-activity";
import { DashboardCharts } from "@/components/dashboard-charts";
import {
  getHealth,
  getJobs,
  getRuns,
  getCatchupQueue,
  type HealthResponse,
  type JobResponse,
  type RunResponse,
  type CatchupQueueSnapshot,
} from "@/lib/api-client";

const GROUP_ORDER = ["daily", "weekly", "periodic"] as const;
const GROUP_META: Record<string, { label: string; desc: string }> = {
  daily: { label: "Daily", desc: "Weekday runs" },
  weekly: { label: "Weekly", desc: "Once or twice a week" },
  periodic: { label: "Periodic", desc: "Recurring interval" },
  other: { label: "Other", desc: "Uncategorized" },
};

interface JobGroup {
  key: string;
  label: string;
  desc: string;
  jobs: JobResponse[];
}

function categorizeJobs(jobs: JobResponse[]): JobGroup[] {
  const buckets: Record<string, JobResponse[]> = {};
  for (const job of jobs) {
    const cat = GROUP_ORDER.find((g) => job.tags.includes(g)) ?? "other";
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push(job);
  }
  const groups: JobGroup[] = [];
  for (const key of [...GROUP_ORDER, "other"]) {
    if (buckets[key]?.length) {
      const meta = GROUP_META[key];
      groups.push({ key, label: meta.label, desc: meta.desc, jobs: buckets[key] });
    }
  }
  return groups;
}

export default function DashboardPage(): React.ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [catchups, setCatchups] = useState<CatchupQueueSnapshot | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [h, j, r, c] = await Promise.all([
        getHealth().catch(() => null),
        getJobs().catch(() => []),
        getRuns({ limit: 200 }).catch(() => []),
        getCatchupQueue().catch(() => null),
      ]);
      setHealth(h);
      setJobs(j);
      setRuns(r);
      setCatchups(c);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const getJobRuns = (jobId: string): RunResponse[] =>
    runs.filter((r) => r.jobId === jobId).slice(0, 10);

  const jobGroups = useMemo(() => categorizeJobs(jobs), [jobs]);

  return (
    <div className="space-y-5 max-w-6xl">
      <StatsCards jobs={jobs} runs={runs} health={health} catchups={catchups} />

      <LifetimeActivity />

      <DashboardCharts runs={runs} jobs={jobs} />

      <AiInsights runs={runs} />

      <section>
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Recent Runs</h2>
        <RunsTable runs={runs} limit={15} grouped />
      </section>

      {/* Jobs by category */}
      {jobGroups.map((group) => (
        <section key={group.key}>
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h2>
            <span className="text-[11px] text-muted-foreground">{group.desc}</span>
            <div className="flex-1 border-t border-border/30 ml-2 mt-0.5" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {group.jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                recentRuns={getJobRuns(job.id)}
                onTrigger={fetchAll}
              />
            ))}
          </div>
        </section>
      ))}
      {jobs.length === 0 && (
        <p className="text-[13px] text-muted-foreground text-center py-8">
          No jobs configured. Add jobs to scheduler.yaml.
        </p>
      )}
    </div>
  );
}
