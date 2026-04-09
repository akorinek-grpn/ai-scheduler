"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RunsTable } from "@/components/runs-table";
import { getRuns, getJobs, type RunResponse, type JobResponse } from "@/lib/api-client";

export default function RunHistoryPage(): React.ReactElement {
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const [r, j] = await Promise.all([
      getRuns({
        limit: 100,
        ...(jobFilter ? { job: jobFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }).catch(() => []),
      getJobs().catch(() => []),
    ]);
    setRuns(r);
    setJobs(j);
  }, [jobFilter, statusFilter]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Run History</h1>
        <p className="text-sm text-muted-foreground mt-1">All runs across all jobs</p>
      </div>

      <div className="space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0 w-12">Job:</span>
          <Button
            variant={jobFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setJobFilter(null)}
          >
            All
          </Button>
          {jobs.map((job) => (
            <Button
              key={job.id}
              variant={jobFilter === job.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setJobFilter(job.id)}
            >
              {job.name}
            </Button>
          ))}
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0 w-12">Status:</span>
          <Button
            variant={statusFilter === null ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setStatusFilter(null)}
          >
            All
          </Button>
          {["success", "failed", "running", "timeout"].map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <RunsTable runs={runs} />
        </CardContent>
      </Card>
    </div>
  );
}
