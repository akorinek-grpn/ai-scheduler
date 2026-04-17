"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CronExpressionParser } from "cron-parser";
import type { JobResponse, RunResponse } from "@/lib/api-client";

interface TimelineProps {
  jobs: JobResponse[];
  runs: RunResponse[];
  startDate: Date;
  days: number;
}

interface TimelineSlot {
  date: Date;
  type: "past" | "future";
  run?: RunResponse;
}

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-500 hover:bg-green-400",
  partial: "bg-amber-500 hover:bg-amber-400",
  failed: "bg-red-500 hover:bg-red-400",
  timeout: "bg-orange-500 hover:bg-orange-400",
  running: "bg-yellow-500 hover:bg-yellow-400 animate-pulse",
};

const STATUS_BORDERS: Record<string, string> = {
  success: "ring-green-500/30",
  partial: "ring-amber-500/30",
  failed: "ring-red-500/30",
  timeout: "ring-orange-500/30",
  running: "ring-yellow-500/30",
};

function formatDayHeader(date: Date): string {
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return "Today";
  if (isTomorrow) return "Tomorrow";
  if (isYesterday) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function getScheduledSlots(schedule: string, startDate: Date, endDate: Date): Date[] {
  try {
    const slots: Date[] = [];

    // Get future occurrences from startDate
    const futureParser = CronExpressionParser.parse(schedule, {
      currentDate: new Date(startDate.getTime() - 1),
    });

    for (let i = 0; i < 200; i++) {
      const next = futureParser.next();
      const d = next.toDate();
      if (d > endDate) break;
      if (d >= startDate) slots.push(d);
    }

    return slots;
  } catch {
    return [];
  }
}

function matchRunToSlot(run: RunResponse, scheduledSlots: Date[]): Date | null {
  const runStart = new Date(run.startedAt);
  // Match a run to the closest scheduled slot within 5 minutes
  for (const slot of scheduledSlots) {
    const diff = Math.abs(runStart.getTime() - slot.getTime());
    if (diff < 5 * 60 * 1000) return slot;
  }
  return null;
}

export function Timeline({ jobs, runs, startDate, days }: TimelineProps): React.ReactElement {
  const endDate = useMemo(() => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + days);
    return d;
  }, [startDate, days]);

  const now = new Date();

  // Generate day columns
  const dayColumns = useMemo(() => {
    const cols: Date[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      cols.push(d);
    }
    return cols;
  }, [startDate, days]);

  // Build timeline data per job
  const jobTimelines = useMemo(() => {
    return jobs.map((job) => {
      const scheduledSlots = getScheduledSlots(job.schedule, startDate, endDate);
      const jobRuns = runs.filter((r) => r.jobId === job.id);

      const slots: TimelineSlot[] = scheduledSlots.map((slotDate) => {
        const isPast = slotDate <= now;

        // Try to find a matching run for this slot
        const matchedRun = jobRuns.find((r) => {
          const runStart = new Date(r.startedAt);
          const diff = Math.abs(runStart.getTime() - slotDate.getTime());
          return diff < 5 * 60 * 1000;
        });

        // Also check manual runs that didn't match a slot
        return {
          date: slotDate,
          type: isPast ? "past" : "future",
          run: matchedRun,
        };
      });

      // Add manual runs that didn't match any scheduled slot
      for (const run of jobRuns) {
        const runStart = new Date(run.startedAt);
        if (runStart < startDate || runStart > endDate) continue;
        const alreadyMatched = slots.some((s) => s.run?.runId === run.runId);
        if (!alreadyMatched) {
          slots.push({
            date: runStart,
            type: "past",
            run,
          });
        }
      }

      slots.sort((a, b) => a.date.getTime() - b.date.getTime());

      return { job, slots };
    });
  }, [jobs, runs, startDate, endDate, now]);

  // Group slots by day for each job
  const getSlotsForDay = (slots: TimelineSlot[], day: Date): TimelineSlot[] => {
    return slots.filter((s) => s.date.toDateString() === day.toDateString());
  };

  if (jobs.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        No jobs configured
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        {/* Header row with day labels */}
        <div className="flex border-b border-border">
          <div className="w-64 shrink-0 px-3 py-2 text-xs font-medium text-muted-foreground">
            Job
          </div>
          {dayColumns.map((day) => {
            const isToday = day.toDateString() === now.toDateString();
            return (
              <div
                key={day.toISOString()}
                className={`flex-1 px-2 py-2 text-xs font-medium text-center border-l border-border ${
                  isToday ? "bg-primary/5 text-foreground" : "text-muted-foreground"
                }`}
              >
                {formatDayHeader(day)}
              </div>
            );
          })}
        </div>

        {/* Job rows */}
        {jobTimelines.map(({ job, slots }) => (
          <div key={job.id} className="flex border-b border-border hover:bg-secondary/20 transition-colors">
            {/* Job name column */}
            <div className={`w-64 shrink-0 px-3 py-3 ${!job.enabled ? "opacity-50" : ""}`}>
              <div className="text-sm font-medium" title={job.name}>{job.name}</div>
              <div className="text-xs text-muted-foreground font-mono truncate">
                {job.directory.split("/").pop()}
              </div>
            </div>

            {/* Day columns with slots */}
            {dayColumns.map((day) => {
              const daySlots = getSlotsForDay(slots, day);
              const isToday = day.toDateString() === now.toDateString();

              return (
                <div
                  key={day.toISOString()}
                  className={`flex-1 px-1 py-2 border-l border-border flex flex-wrap items-start gap-1 content-start ${
                    isToday ? "bg-primary/5" : ""
                  }`}
                >
                  {daySlots.map((slot, i) => {
                    const isFuture = slot.type === "future";
                    const run = slot.run;
                    const statusColor = run ? STATUS_COLORS[run.status] ?? "bg-muted-foreground" : "";
                    const statusBorder = run ? STATUS_BORDERS[run.status] ?? "" : "";

                    const block = (
                      <div
                        key={`${slot.date.getTime()}-${i}`}
                        title={`${formatTime(slot.date)}${run ? ` — ${run.status}` : " — scheduled"}${
                          run?.evaluation?.summary ? `\n${run.evaluation.summary}` : ""
                        }`}
                        className={`
                          h-6 min-w-[24px] px-1.5 rounded text-[10px] font-medium
                          flex items-center justify-center
                          transition-all cursor-default
                          ${isFuture && !run
                            ? "bg-muted text-muted-foreground border border-dashed border-border"
                            : `${statusColor} text-white ring-1 ${statusBorder}`
                          }
                          ${run ? "cursor-pointer" : ""}
                        `}
                      >
                        {formatTime(slot.date).replace(/ (AM|PM)/, "")}
                      </div>
                    );

                    if (run) {
                      return (
                        <Link key={`${slot.date.getTime()}-${i}`} href={`/runs/${run.jobId}/${run.runId}`}>
                          {block}
                        </Link>
                      );
                    }
                    return block;
                  })}
                  {daySlots.length === 0 && !job.enabled && (
                    <span className="text-[10px] text-muted-foreground italic">disabled</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-4 px-3 py-3 text-xs text-muted-foreground">
          <span className="font-medium">Legend:</span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-green-500" /> success
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-red-500" /> failed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-orange-500" /> timeout
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-yellow-500" /> running
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-dashed border-border bg-muted" /> scheduled
          </span>
        </div>
      </div>
    </div>
  );
}
