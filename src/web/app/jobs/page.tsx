"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RunHistoryDots } from "@/components/run-history-dots";
import { getJobs, getRuns, triggerJob, setJobEnabled, type JobResponse, type RunResponse } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";

const severityStyles: Record<string, string> = {
  ok: "text-green-500",
  info: "text-blue-500",
  warning: "text-amber-500",
  critical: "text-red-500",
};

const severityIcons: Record<string, string> = {
  ok: "\u2713",
  info: "\u2139",
  warning: "\u26A0",
  critical: "!!",
};

// Tag categorization — frequency tags get their own section, as do project tags
const FREQUENCY_TAGS = new Set(["daily", "weekly", "twice-weekly", "periodic"]);
const PROJECT_TAGS = new Set([
  "personalized-helper", "gsc-analytics", "market-researcher",
  "echelon", "next-pwa-app",
]);

interface TagSection {
  label: string;
  tags: string[];
}

function categorizeTags(allTags: string[]): TagSection[] {
  const frequency: string[] = [];
  const project: string[] = [];
  const purpose: string[] = [];

  for (const tag of allTags) {
    if (FREQUENCY_TAGS.has(tag)) frequency.push(tag);
    else if (PROJECT_TAGS.has(tag)) project.push(tag);
    else purpose.push(tag);
  }

  const sections: TagSection[] = [];
  if (frequency.length > 0) sections.push({ label: "Frequency", tags: frequency });
  if (project.length > 0) sections.push({ label: "Project", tags: project });
  if (purpose.length > 0) sections.push({ label: "Purpose", tags: purpose });
  return sections;
}

// Group jobs by frequency for sectioned display
const GROUP_ORDER = ["daily", "weekly", "twice-weekly", "periodic"] as const;
const GROUP_LABELS: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  "twice-weekly": "Twice Weekly",
  periodic: "Periodic",
  other: "Other",
};

interface JobGroup {
  key: string;
  label: string;
  jobs: JobResponse[];
}

function groupJobsByFrequency(jobs: JobResponse[]): JobGroup[] {
  const buckets: Record<string, JobResponse[]> = {};

  for (const job of jobs) {
    const freq = GROUP_ORDER.find((g) => job.tags.includes(g)) ?? "other";
    if (!buckets[freq]) buckets[freq] = [];
    buckets[freq].push(job);
  }

  const groups: JobGroup[] = [];
  for (const key of [...GROUP_ORDER, "other"]) {
    if (buckets[key]?.length) {
      groups.push({ key, label: GROUP_LABELS[key] ?? key, jobs: buckets[key] });
    }
  }
  return groups;
}

export default function JobsPage(): React.ReactElement {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [runs, setRuns] = useState<RunResponse[]>([]);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "claude" | "script">("all");
  const [searchQuery, setSearchQuery] = useState("");

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

  const allTags = useMemo(() => [...new Set(jobs.flatMap((j) => j.tags))].sort(), [jobs]);
  const tagSections = useMemo(() => categorizeTags(allTags), [allTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const clearFilters = () => {
    setSelectedTags(new Set());
    setEnabledFilter("all");
    setTypeFilter("all");
    setSearchQuery("");
  };

  const hasActiveFilters = selectedTags.size > 0 || enabledFilter !== "all" || typeFilter !== "all" || searchQuery !== "";

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (selectedTags.size > 0 && ![...selectedTags].some((t) => job.tags.includes(t))) return false;
      if (enabledFilter === "enabled" && !job.enabled) return false;
      if (enabledFilter === "disabled" && job.enabled) return false;
      if (typeFilter !== "all" && job.type !== typeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = job.name.toLowerCase().includes(q);
        const matchesId = job.id.toLowerCase().includes(q);
        const matchesDir = job.directory.toLowerCase().includes(q);
        if (!matchesName && !matchesId && !matchesDir) return false;
      }
      return true;
    });
  }, [jobs, selectedTags, enabledFilter, typeFilter, searchQuery]);

  const jobGroups = useMemo(() => groupJobsByFrequency(filteredJobs), [filteredJobs]);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filteredJobs.length} of {jobs.length} jobs
            {hasActiveFilters && " (filtered)"}
          </p>
        </div>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          {/* Search */}
          <div>
            <input
              type="text"
              placeholder="Search by name, ID, or directory..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-secondary/50 border border-border rounded-md px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Quick filters row */}
          <div className="flex gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium w-12">Status</span>
              {(["all", "enabled", "disabled"] as const).map((v) => (
                <Button
                  key={v}
                  variant={enabledFilter === v ? "secondary" : "ghost"}
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setEnabledFilter(v)}
                >
                  {v}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium w-12">Type</span>
              {(["all", "claude", "script"] as const).map((v) => (
                <Button
                  key={v}
                  variant={typeFilter === v ? "secondary" : "ghost"}
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => setTypeFilter(v)}
                >
                  {v}
                </Button>
              ))}
            </div>
          </div>

          {/* Tag sections */}
          {tagSections.map((section) => (
            <div key={section.label} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium w-12 shrink-0">
                {section.label}
              </span>
              {section.tags.map((tag) => {
                const isSelected = selectedTags.has(tag);
                const count = jobs.filter((j) => j.tags.includes(tag)).length;
                return (
                  <Button
                    key={tag}
                    variant={isSelected ? "secondary" : "ghost"}
                    size="sm"
                    className="text-xs h-7 px-2 gap-1"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                    <span className="text-[10px] text-muted-foreground/60">{count}</span>
                  </Button>
                );
              })}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Job groups */}
      {jobGroups.map((group) => (
        <div key={group.key}>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm font-semibold">{group.label}</h2>
            <div className="flex-1 border-t border-border/40" />
            <span className="text-xs text-muted-foreground">{group.jobs.length} jobs</span>
          </div>
          <div className="space-y-3">
            {group.jobs.map((job) => {
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
                        <Badge variant="outline" className="text-[10px] text-muted-foreground/70">
                          {job.type}
                        </Badge>
                        {!job.enabled && (
                          <Badge variant="outline" className="text-muted-foreground">disabled</Badge>
                        )}
                        {job.tags.map((tag) => (
                          <Badge
                            key={tag}
                            variant={selectedTags.has(tag) ? "secondary" : "outline"}
                            className="text-xs text-muted-foreground cursor-pointer"
                            onClick={() => toggleTag(tag)}
                          >
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
                      <div className="text-xs text-muted-foreground mt-1 max-w-xl truncate">
                        {job.type === "script" ? `$ ${job.command}` : job.prompt}
                      </div>

                      {lastEval && (
                        <div className="mt-2 flex items-start gap-2 text-xs">
                          <span className={severityStyles[lastEval.severity] ?? "text-muted-foreground"}>
                            {severityIcons[lastEval.severity] ?? "?"}
                          </span>
                          <p className="text-muted-foreground leading-relaxed line-clamp-1">
                            {lastEval.summary}
                            {lastEval.followUpNeeded && (
                              <span className="text-amber-500 ml-2">{"\u2014"} follow-up needed</span>
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
                                ? "border-green-500/30 bg-green-500/10 text-green-500"
                                : lastRun.status === "partial"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
                                  : lastRun.status === "failed"
                                    ? "border-red-500/30 bg-red-500/10 text-red-500"
                                    : lastRun.status === "timeout"
                                      ? "border-orange-500/30 bg-orange-500/10 text-orange-500"
                                      : lastRun.status === "running"
                                        ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-500"
                                        : "border-border bg-muted text-muted-foreground"
                            }`}
                          >
                            {lastRun.status === "success" && "\u2713"}
                            {lastRun.status === "partial" && "\u26A0"}
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
                          className={job.enabled ? "text-muted-foreground" : "text-green-500"}
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
          </div>
        </div>
      ))}
      {filteredJobs.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          {jobs.length === 0 ? "No jobs configured" : "No jobs match filters"}
        </p>
      )}
    </div>
  );
}
