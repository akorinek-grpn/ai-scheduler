"use client";

import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RunsTable } from "@/components/runs-table";
import { getRuns, getJobs, getHealth, type RunResponse, type JobResponse, type HealthResponse } from "@/lib/api-client";
import { useHostView } from "@/components/host-view";
import { COST_DISCLAIMER } from "@/lib/cost-format";
import { isCatchupRun } from "@/lib/catchup-runs";

export default function RunHistoryPage(): React.ReactElement {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading runs…</p>}><RunHistoryContent /></Suspense>;
}

function RunHistoryContent(): React.ReactElement {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const jobFilter = searchParams.get("job") || null;
  // ?trigger=catchup is where the sidebar pill and the dashboard's catch-up panel link to.
  const catchupOnly = searchParams.get("trigger") === "catchup";
  // ?scope=all also lists this Mac's runs of jobs that now run elsewhere (history from before the
  // move); the default shows the jobs placed here.
  const allHosts = searchParams.get("scope") === "all";
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  // Whose runs: ?host= (from a link, e.g. the cost list) wins over the sidebar's choice.
  const { hostParam: viewHost, isSelfHost } = useHostView();
  const linkedHost = searchParams.get("host");
  const hostParam = linkedHost ? (isSelfHost(linkedHost) ? undefined : linkedHost) : viewHost;

  const replaceQuery = (edit: (query: URLSearchParams) => void): void => {
    const query = new URLSearchParams(searchParams.toString());
    edit(query);
    router.replace(`/runs${query.size ? `?${query}` : ""}`, { scroll: false });
  };

  const setJobFilter = (jobId: string | null): void => {
    replaceQuery((query) => {
      if (jobId) query.set("job", jobId);
      else query.delete("job");
    });
  };

  const setCatchupOnly = (on: boolean): void => {
    replaceQuery((query) => {
      if (on) query.set("trigger", "catchup");
      else query.delete("trigger");
    });
  };

  const setAllHosts = (on: boolean): void => {
    replaceQuery((query) => {
      if (on) query.set("scope", "all");
      else query.delete("scope");
    });
  };

  const fetchAll = useCallback(async () => {
    const [r, j, h] = await Promise.all([
      getRuns({
        limit: 200,
        ...(jobFilter ? { job: jobFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(catchupOnly ? { trigger: "catchup" as const } : {}),
        ...(allHosts ? { scope: "all" as const } : {}),
        host: hostParam,
      }).catch(() => []),
      getJobs(hostParam).catch(() => []),
      getHealth().catch(() => null),
    ]);
    // A daemon started before ?trigger= existed ignores it, so filter here too.
    setRuns(catchupOnly ? r.filter(isCatchupRun) : r);
    setJobs(j);
    setHealth(h);
  }, [jobFilter, statusFilter, catchupOnly, allHosts, hostParam]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Summary stats for current filter
  const stats = useMemo(() => {
    const total = runs.length;
    const success = runs.filter((r) => r.status === "success").length;
    const partial = runs.filter((r) => r.status === "partial").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const timeout = runs.filter((r) => r.status === "timeout").length;
    const running = runs.filter((r) => r.status === "running").length;
    const deferred = runs.filter((r) => r.status === "deferred").length;
    const blocked = runs.filter((r) => r.status === "blocked").length;
    const killed = runs.filter((r) => r.status === "killed").length;
    const followUp = runs.filter((r) => r.evaluation?.followUpNeeded).length;
    return { total, success, partial, failed, timeout, running, deferred, blocked, killed, followUp };
  }, [runs]);

  const isFiltered = jobFilter !== null || statusFilter !== null || catchupOnly;

  return (
    <div className="space-y-3 max-w-5xl">
      {/* Header + summary */}
      <div className="flex items-center gap-4">
        <h1 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Runs</h1>
        <div className="flex items-center gap-3 text-[12px] text-muted-foreground tabular-nums">
          <span>{stats.total} total</span>
          {stats.success > 0 && <span className="text-green-500">{stats.success} ok</span>}
          {stats.partial > 0 && <span className="text-amber-500">{stats.partial} partial</span>}
          {stats.failed > 0 && <span className="text-red-500">{stats.failed} failed</span>}
          {stats.timeout > 0 && <span className="text-orange-500">{stats.timeout} timeout</span>}
          {stats.killed > 0 && <span className="text-red-500">{stats.killed} killed</span>}
          {stats.blocked > 0 && <span className="text-amber-500">{stats.blocked} blocked</span>}
          {stats.deferred > 0 && <span className="text-slate-400">{stats.deferred} deferred</span>}
          {stats.running > 0 && <span className="text-yellow-500">{stats.running} running</span>}
          {stats.followUp > 0 && <span className="text-amber-500">{stats.followUp} follow-up</span>}
        </div>
        {isFiltered && (
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] h-5 px-1.5 text-muted-foreground ml-auto"
            onClick={() => {
              replaceQuery((query) => {
                query.delete("job");
                query.delete("trigger");
              });
              setStatusFilter(null);
            }}
          >
            clear
          </Button>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">{COST_DISCLAIMER} Partial totals exclude missing costs; unavailable is not zero.</p>
      {health?.host && (
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            checked={allHosts}
            onChange={(e) => setAllHosts(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Include history of jobs that now run on another Mac
        </label>
      )}
      {jobFilter && <p className="text-[12px] text-muted-foreground">Job: {jobs.find((job) => job.id === jobFilter)?.name ?? jobFilter}</p>}

      {/* Filters */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 items-center">
        {/* Job filter */}
        <div className="flex flex-wrap items-center gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1 w-6">job</span>
          <button
            onClick={() => setJobFilter(null)}
            className={`px-1.5 py-0.5 rounded text-[12px] transition-colors ${
              jobFilter === null
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            }`}
          >
            all
          </button>
          {jobs.filter((job, i, all) => all.findIndex((other) => other.id === job.id) === i).map((job) => (
            <button
              key={job.id}
              onClick={() => setJobFilter(jobFilter === job.id ? null : job.id)}
              className={`px-1.5 py-0.5 rounded text-[12px] transition-colors truncate max-w-[120px] ${
                jobFilter === job.id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
              title={job.name}
            >
              {job.name.replace(/^(Daily |Weekly |Afternoon |Market |Executive |Compliance |EOD |Babysit |AI |My |Skill )/, "").split(" ")[0]}
            </button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1 w-6">sts</span>
          <button
            onClick={() => setStatusFilter(null)}
            className={`px-1.5 py-0.5 rounded text-[12px] transition-colors ${
              statusFilter === null
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            }`}
          >
            all
          </button>
          {(["success", "partial", "failed", "running", "timeout", "blocked", "deferred", "killed"] as const).map((s) => {
            const colors: Record<string, string> = {
              success: "text-green-500",
              partial: "text-amber-500",
              failed: "text-red-500",
              running: "text-yellow-500",
              timeout: "text-orange-500",
              blocked: "text-amber-500",
              deferred: "text-slate-400",
              killed: "text-red-500",
            };
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                className={`px-1.5 py-0.5 rounded text-[12px] transition-colors ${
                  statusFilter === s
                    ? `bg-secondary ${colors[s]}`
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>

        {/* Catch-up filter */}
        <button
          type="button"
          aria-pressed={catchupOnly}
          onClick={() => setCatchupOnly(!catchupOnly)}
          className={`inline-flex min-h-[24px] items-center gap-1 rounded px-1.5 text-[12px] transition-colors ${
            catchupOnly
              ? "bg-secondary text-blue-700 dark:text-blue-400"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          }`}
        >
          <span aria-hidden="true">↻</span>
          Catch-ups
        </button>
      </div>

      {/* Run list */}
      <RunsTable runs={runs} grouped />
    </div>
  );
}
