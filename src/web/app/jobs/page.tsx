"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunHistoryDots } from "@/components/run-history-dots";
import { getJobs, getRuns, triggerJob, setJobEnabled, type JobResponse, type RunResponse } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";

const severityStyles: Record<string, string> = {
  ok: "text-green-400",
  info: "text-blue-400",
  warning: "text-amber-400",
  critical: "text-red-400",
};

const severityIcons: Record<string, string> = {
  ok: "\u2713",
  info: "\u2139",
  warning: "\u26A0",
  critical: "!!",
};

export default function JobsPage(): React.ReactElement {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [j, r] = await Promise.all([
      getJobs().catch(() => []),
      getRuns({ limit: 100 }).catch(() => []),
    ]);
    setJobs(j);
    setRuns(r);
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const allTags = [...new Set(jobs.flatMap((j) => j.tags))].sort();
  const filteredJobs = tagFilter ? jobs.filter((j) => j.tags.includes(tagFilter)) : jobs;

  const handleToggle = async (jobId: string, currentlyEnabled: boolean) => {
    setTogglingId(jobId);
    try {
      await setJobEnabled(jobId, !currentlyEnabled);
      fetchAll();
    } catch (err) {
      console.error("Toggle failed:", err);
    } finally {
      setTogglingId(null);
    }
  };

  const handleTrigger = async (jobId: string) => {
    setTriggeringId(jobId);
    try {
      await triggerJob(jobId);
      fetchAll();
    } catch (err) {
      console.error("Trigger failed:", err);
    } finally {
      setTriggeringId(null);
    }
  };

  const getJobRuns = (jobId: string): RunResponse[] =>
    runs.filter((r) => r.jobId === jobId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground mt-1">All configured scheduled jobs</p>
      </div>

      {allTags.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={tagFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTagFilter(null)}
          >
            All
          </Button>
          {allTags.map((tag) => (
            <Button
              key={tag}
              variant={tagFilter === tag ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTagFilter(tag)}
            >
              {tag}
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filteredJobs.map((job) => {
          const jobRuns = getJobRuns(job.id);
          const lastRun = jobRuns[0];
          const lastEval = jobRuns.find((r) => r.evaluation)?.evaluation;
          const completedRuns = jobRuns.filter((r) => r.status !== "running");
          const successCount = completedRuns.filter((r) => r.status === "success").length;
          const successRate = completedRuns.length > 0
            ? Math.round((successCount / completedRuns.length) * 100)
            : null;

          return (
            <Card key={job.id} className={!job.enabled ? "opacity-50" : ""}>
              <CardContent className="flex items-start gap-4 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{job.name}</span>
                    {!job.enabled && (
                      <Badge variant="outline" className="text-zinc-500">disabled</Badge>
                    )}
                    {job.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">
                        {tag}
                      </Badge>
                    ))}
                    {successRate !== null && (
                      <span className={`text-xs ${
                        successRate >= 80 ? "text-green-500" : successRate >= 50 ? "text-amber-500" : "text-red-500"
                      }`}>
                        {successRate}% pass rate
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    <span className="font-mono">{job.directory}</span>
                    <span className="mx-2">{"\u00B7"}</span>
                    <span>{formatCronHuman(job.schedule)}</span>
                    {job.model && <><span className="mx-2">{"\u00B7"}</span><span>model: {job.model}</span></>}
                  </div>
                  <div className="text-xs text-zinc-600 mt-1 max-w-xl truncate">
                    {job.type === "script" ? `$ ${job.command}` : job.prompt}
                  </div>

                  {/* Latest AI evaluation */}
                  {lastEval && (
                    <div className="mt-2 flex items-start gap-2 text-xs">
                      <span className={severityStyles[lastEval.severity] ?? "text-muted-foreground"}>
                        {severityIcons[lastEval.severity] ?? "?"}
                      </span>
                      <p className="text-muted-foreground leading-relaxed line-clamp-1">
                        {lastEval.summary}
                        {lastEval.followUpNeeded && (
                          <span className="text-amber-400 ml-2">{"\u2014"} follow-up needed</span>
                        )}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  {jobRuns.length > 0 && (
                    <RunHistoryDots runs={jobRuns} count={3} />
                  )}
                  <div className="flex items-center gap-2">
                    {lastRun && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium border ${
                          lastRun.status === "success"
                            ? "border-green-500/30 bg-green-500/10 text-green-400"
                            : lastRun.status === "failed"
                              ? "border-red-500/30 bg-red-500/10 text-red-400"
                              : lastRun.status === "timeout"
                                ? "border-orange-500/30 bg-orange-500/10 text-orange-400"
                                : lastRun.status === "running"
                                  ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                                  : "border-zinc-500/30 bg-zinc-500/10 text-zinc-400"
                        }`}
                      >
                        {lastRun.status === "success" && "\u2713"}
                        {lastRun.status === "failed" && "\u2717"}
                        {lastRun.status === "timeout" && "\u23F1"}
                        {lastRun.status === "running" && (
                          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />
                        )}
                        last {lastRun.status}
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className={job.enabled ? "text-muted-foreground" : "text-green-400"}
                      onClick={() => handleToggle(job.id, job.enabled)}
                      disabled={togglingId === job.id || job.isActive}
                    >
                      {togglingId === job.id ? "..." : job.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleTrigger(job.id)}
                      disabled={triggeringId === job.id || job.isActive || !job.enabled}
                    >
                      {triggeringId === job.id ? "Starting..." : "Run now"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {filteredJobs.length === 0 && (
          <p className="text-center text-muted-foreground py-8">
            {jobs.length === 0 ? "No jobs configured" : "No jobs match filter"}
          </p>
        )}
      </div>
    </div>
  );
}
