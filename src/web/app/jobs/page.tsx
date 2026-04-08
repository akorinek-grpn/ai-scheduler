"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getJobs, getRuns, triggerJob, type JobResponse, type RunResponse } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";

export default function JobsPage(): React.ReactElement {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
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

  const getLastRun = (jobId: string): RunResponse | undefined =>
    runs.find((r) => r.jobId === jobId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm text-muted-foreground mt-1">All configured scheduled jobs</p>
      </div>

      {allTags.length > 0 && (
        <div className="flex gap-2">
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
          const lastRun = getLastRun(job.id);
          return (
            <Card key={job.id} className={!job.enabled ? "opacity-50" : ""}>
              <CardContent className="flex items-center gap-4 py-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{job.name}</span>
                    {!job.enabled && (
                      <Badge variant="outline" className="text-zinc-500">disabled</Badge>
                    )}
                    {job.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    <span className="font-mono">{job.directory}</span>
                    <span className="mx-2">·</span>
                    <span>{formatCronHuman(job.schedule)}</span>
                    {job.model && <><span className="mx-2">·</span><span>model: {job.model}</span></>}
                  </div>
                  <div className="text-xs text-zinc-600 mt-1 max-w-xl truncate">{job.prompt}</div>
                </div>
                <div className="flex items-center gap-3">
                  {lastRun && (
                    <span className="text-xs text-muted-foreground">
                      Last: {lastRun.status === "success" ? "✓" : lastRun.status === "failed" ? "✗" : "..."}
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => handleTrigger(job.id)}
                    disabled={triggeringId === job.id || job.isActive}
                  >
                    {triggeringId === job.id ? "Starting..." : "Run now"}
                  </Button>
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
