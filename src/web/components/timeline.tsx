"use client";

import { runHref } from "@/lib/api-client";
import { useMemo } from "react";
import Link from "next/link";
import { CronExpressionParser } from "cron-parser";
import type { JobResponse, RunResponse } from "@/lib/api-client";
import { PlacementBadge, placedHostNames, useHostView } from "./host-view";

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
  const { multi, hosts, colorOf, roleOf } = useHostView();
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
      // A row is one job on one Mac. It shows that Mac's runs, plus runs from a Mac the job is no
      // longer scheduled on (history from before it moved), outlined in that Mac's color.
      const placed = placedHostNames(hosts, job.runs_on);
      const jobRuns = runs.filter(
        (r) =>
          r.jobId === job.id &&
          (!multi || !job.host || !r.host || r.host === job.host || !placed.includes(r.host)),
      );

      const slots: TimelineSlot[] = scheduledSlots.map((slotDate) => {
        const isPast = slotDate <= now;

        // Try to find a matching run for this slot
        const matchedRun = jobRuns.find((r) => {
          // A catch-up run fills the slot it caught up, however late it started.
          if (r.catchupFor) return Math.abs(new Date(r.catchupFor).getTime() - slotDate.getTime()) < 60 * 1000;
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

      // Runs are pruned oldest first, so an empty past slot after the row's earliest kept run was
      // missed; before it, the run may simply no longer be kept.
      const firstKept = jobRuns.reduce(
        (earliest, r) => Math.min(earliest, new Date(r.startedAt).getTime()),
        Infinity,
      );

      return { job, slots, firstKept };
    });
  }, [jobs, runs, startDate, endDate, now, hosts, multi]);

  // With several Macs, rows are grouped under the Mac that schedules them.
  const groups = useMemo(() => {
    if (!multi) return [{ host: null, rows: jobTimelines }];
    const byHost = hosts
      .map((host) => ({ host, rows: jobTimelines.filter((t) => t.job.host === host.name) }))
      .filter((group) => group.rows.length > 0);
    const unplaced = jobTimelines.filter((t) => !hosts.some((h) => h.name === t.job.host));
    return unplaced.length ? [...byHost, { host: null, rows: unplaced }] : byHost;
  }, [jobTimelines, hosts, multi]);

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

        {/* Job rows, under a header per Mac */}
        {groups.map(({ host, rows }) => (
          <div key={host?.name ?? "jobs"} role="rowgroup" aria-label={host ? `Scheduled on ${host.role}` : undefined}>
            {host && (
              <div
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border bg-secondary/40 px-3 py-2 text-xs"
                style={{ boxShadow: `inset 4px 0 0 ${colorOf(host.name)}` }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorOf(host.name) }} aria-hidden="true" />
                <span className="font-semibold text-foreground">Scheduled on {host.role}</span>
                <span className="font-mono text-muted-foreground">{host.name}</span>
                <span className="text-muted-foreground">
                  · {host.isSelf ? "this Mac" : "read-only"} · {rows.length} job{rows.length === 1 ? "" : "s"}
                </span>
              </div>
            )}
        {rows.map(({ job, slots, firstKept }) => (
          <div
            key={`${job.host ?? ""}/${job.id}`}
            className="flex border-b border-border hover:bg-secondary/20 transition-colors"
            style={multi && job.host ? { boxShadow: `inset 4px 0 0 ${colorOf(job.host)}` } : undefined}
          >
            {/* Job name column */}
            <div className={`w-64 shrink-0 px-3 py-3 ${!job.enabled ? "opacity-50" : ""}`}>
              <div className="text-sm font-medium" title={job.name}>{job.name}</div>
              <PlacementBadge runsOn={job.runs_on} className="mt-1" />
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
                    // A run from another Mac than the row's: history from before the job moved.
                    const ranElsewhere = multi && run?.host && job.host && run.host !== job.host ? run.host : null;
                    const missed = !run && !isFuture && slot.date.getTime() > firstKept;
                    const caughtUp = run?.catchupFor && run.startedAt ? ` · caught up at ${formatTime(new Date(run.startedAt))}` : "";
                    const what = run
                      ? ` — ${run.status}${caughtUp}${ranElsewhere ? ` · ran on ${roleOf(ranElsewhere)}` : ""}`
                      : isFuture
                        ? " — scheduled"
                        : missed
                          ? " — missed: no run"
                          : " — no record: missed, or pruned (each job keeps only its latest runs)";

                    const block = (
                      <div
                        key={`${slot.date.getTime()}-${i}`}
                        title={`${formatTime(slot.date)}${what}${
                          run?.evaluation?.summary ? `\n${run.evaluation.summary}` : ""
                        }`}
                        className={`
                          h-6 min-w-[24px] px-1.5 rounded text-[10px] font-medium
                          flex items-center justify-center
                          transition-all cursor-default
                          ${run
                            ? `${statusColor} text-white ${ranElsewhere ? "" : `ring-1 ${statusBorder}`}`
                            : isFuture
                              ? "bg-muted text-muted-foreground border border-dashed border-border"
                              : missed
                                ? "border border-border text-muted-foreground"
                                : "text-muted-foreground/40"
                          }
                          ${run ? "cursor-pointer" : ""}
                        `}
                        style={
                          ranElsewhere
                            ? { boxShadow: `0 0 0 2px var(--color-card), 0 0 0 4px ${colorOf(ranElsewhere)}` }
                            : undefined
                        }
                      >
                        {formatTime(slot.date).replace(/ (AM|PM)/, "")}
                      </div>
                    );

                    if (run) {
                      return (
                        <Link key={`${slot.date.getTime()}-${i}`} href={runHref(run)}>
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
            <span className="inline-block h-3 w-3 rounded bg-amber-500" /> partial
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-dashed border-border bg-muted" /> scheduled
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-border" /> missed
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground/40">9:00</span> no record kept
          </span>
          {multi && (
            <span className="flex items-center gap-1.5">
              <span
                className="ml-1 inline-block h-3 w-3 rounded bg-green-500"
                style={{ boxShadow: `0 0 0 1.5px var(--color-card), 0 0 0 3px ${colorOf(hosts.find((h) => h.isSelf)?.name)}` }}
              />
              outlined in a Mac&apos;s color: that Mac ran it, before the job moved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
