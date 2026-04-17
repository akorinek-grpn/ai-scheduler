"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { RunResponse, JobResponse } from "@/lib/api-client";

interface DashboardChartsProps {
  runs: RunResponse[];
  jobs: JobResponse[];
}

// --- Activity chart: runs per day stacked by status ---

interface DayBucket {
  label: string;
  date: string;
  success: number;
  partial: number;
  failed: number;
  timeout: number;
  running: number;
  total: number;
}

function buildDayBuckets(runs: RunResponse[], dayCount: number): DayBucket[] {
  const buckets: DayBucket[] = [];
  const now = new Date();

  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const dateStr = d.toISOString().slice(0, 10);
    const isToday = i === 0;
    const label = isToday
      ? "Today"
      : d.toLocaleDateString("en-US", { weekday: "short" });

    buckets.push({
      label,
      date: dateStr,
      success: 0,
      partial: 0,
      failed: 0,
      timeout: 0,
      running: 0,
      total: 0,
    });
  }

  for (const run of runs) {
    const dateStr = new Date(run.startedAt).toISOString().slice(0, 10);
    const bucket = buckets.find((b) => b.date === dateStr);
    if (bucket) {
      bucket[run.status] = (bucket[run.status] ?? 0) + 1;
      bucket.total++;
    }
  }

  return buckets;
}

function ActivityChart({ runs }: { runs: RunResponse[] }): React.ReactElement {
  const data = useMemo(() => buildDayBuckets(runs, 7), [runs]);

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-[140px] text-muted-foreground text-[13px]">
        No run data yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} barCategoryGap="20%">
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          width={24}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "var(--color-card)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            color: "var(--color-foreground)",
          }}
          cursor={{ fill: "var(--color-secondary)", opacity: 0.5 }}
        />
        <Bar dataKey="success" stackId="a" fill="oklch(0.65 0.17 150)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="partial" stackId="a" fill="oklch(0.75 0.17 75)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="failed" stackId="a" fill="oklch(0.60 0.22 25)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="timeout" stackId="a" fill="oklch(0.70 0.17 55)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="running" stackId="a" fill="oklch(0.75 0.15 85)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// --- Job health heatmap: jobs x recent days ---

interface HeatmapCell {
  status: "success" | "partial" | "failed" | "timeout" | "mixed" | "none";
  count: number;
}

const heatColors: Record<string, string> = {
  success: "bg-green-500",
  partial: "bg-amber-500",
  failed: "bg-red-500",
  timeout: "bg-orange-500",
  mixed: "bg-amber-500",
  none: "bg-muted",
};

function JobHeatmap({ runs, jobs }: { runs: RunResponse[]; jobs: JobResponse[] }): React.ReactElement {
  const dayCount = 7;
  const now = new Date();

  const days = useMemo(() => {
    const d: { date: string; label: string }[] = [];
    for (let i = dayCount - 1; i >= 0; i--) {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - i);
      dt.setHours(0, 0, 0, 0);
      d.push({
        date: dt.toISOString().slice(0, 10),
        label: i === 0 ? "Today" : dt.toLocaleDateString("en-US", { weekday: "narrow" }),
      });
    }
    return d;
  }, []);

  const grid = useMemo(() => {
    const enabledJobs = jobs.filter((j) => j.enabled);
    return enabledJobs.map((job) => {
      const jobRuns = runs.filter((r) => r.jobId === job.id);
      const cells: HeatmapCell[] = days.map(({ date }) => {
        const dayRuns = jobRuns.filter((r) => new Date(r.startedAt).toISOString().slice(0, 10) === date);
        if (dayRuns.length === 0) return { status: "none", count: 0 };
        const hasFailed = dayRuns.some((r) => r.status === "failed");
        const hasTimeout = dayRuns.some((r) => r.status === "timeout");
        const hasPartial = dayRuns.some((r) => r.status === "partial");
        const allSuccess = dayRuns.every((r) => r.status === "success");
        if (allSuccess) return { status: "success", count: dayRuns.length };
        if (hasFailed) return { status: "failed", count: dayRuns.length };
        if (hasTimeout) return { status: "timeout", count: dayRuns.length };
        if (hasPartial) return { status: "partial", count: dayRuns.length };
        return { status: "mixed", count: dayRuns.length };
      });
      return { job, cells };
    });
  }, [jobs, runs, days]);

  if (grid.length === 0) {
    return (
      <div className="flex items-center justify-center h-[100px] text-muted-foreground text-[13px]">
        No jobs configured
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[400px]">
        {/* Day headers */}
        <div className="flex items-center mb-1">
          <div className="w-[140px] shrink-0" />
          {days.map((d) => (
            <div key={d.date} className="flex-1 text-center text-[11px] text-muted-foreground">
              {d.label}
            </div>
          ))}
        </div>

        {/* Job rows */}
        {grid.map(({ job, cells }) => (
          <div key={job.id} className="flex items-center gap-1 mb-0.5">
            <div className="w-[140px] shrink-0 text-[12px] truncate text-foreground" title={job.name}>
              {job.name}
            </div>
            {cells.map((cell, i) => (
              <div
                key={days[i].date}
                className={`flex-1 h-5 rounded-sm ${heatColors[cell.status]} ${
                  cell.status === "none" ? "opacity-30" : "opacity-80"
                }`}
                title={`${job.name} — ${days[i].date}: ${cell.count} run${cell.count !== 1 ? "s" : ""} (${cell.status})`}
              />
            ))}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-green-500 opacity-80" /> ok</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-red-500 opacity-80" /> fail</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-orange-500 opacity-80" /> timeout</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-muted opacity-30" /> no run</span>
        </div>
      </div>
    </div>
  );
}

// --- Export ---

export function DashboardCharts({ runs, jobs }: DashboardChartsProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section className="rounded border border-border p-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Activity — Last 7 Days
        </h3>
        <ActivityChart runs={runs} />
      </section>
      <section className="rounded border border-border p-4">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Job Health
        </h3>
        <JobHeatmap runs={runs} jobs={jobs} />
      </section>
    </div>
  );
}
