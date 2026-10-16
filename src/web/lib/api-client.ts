import type {
  CostStatsResponse,
  CostTotals,
  RunCostSummary,
} from "../../shared/cost-types";
import type { RunGraph } from "../../shared/run-graph-types";
import type { RunDecision } from "../../shared/types";

const DAEMON_API_BASE = "/api";

export type CostPeriod = 7 | 30 | 90;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The host this daemon resolved from scheduler.yaml `hosts`; absent on a single-Mac setup. */
export interface HostInfo {
  name: string;
  role: string;
}

/** The usage hold: that Mac's Claude jobs are held until `until` (its account's window is exhausted). */
export interface UsageHoldInfo {
  kind: "weekly" | "session";
  until: string;
  since: string;
  text?: string;
  skipped: number;
  jobId?: string | null;
  runId?: string | null;
}

export interface HealthResponse {
  status: string;
  pid: number;
  startedAt: string;
  activeJobs: string[];
  host?: HostInfo | null;
  draining?: boolean;
  usageHold?: UsageHoldInfo | null;
}

/** One window of a headroom sample (scripts/usage-headroom.py). */
export interface UsageWindow {
  label: string;
  utilization_percent: number | null;
  assumed_fraction?: boolean;
  resets_at: string | null;
}

export interface UsageSample {
  version?: number;
  at: string;
  host?: string;
  status: "ok" | "unavailable";
  http?: number | null;
  parsed?: boolean;
  windows: Record<string, UsageWindow>;
  error?: string | null;
}

export interface UsageResponse {
  latest: UsageSample | null;
  samples: UsageSample[];
  hold: UsageHoldInfo | null;
}

export interface HostJobSummary {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  runs_on: string | string[];
}

/**
 * Link to a run's page. A run from a multi-host setup carries the host that ran it, and the
 * page needs it to read that host's data (another Mac's comes from its mirror).
 */
export function runHref(run: { jobId: string; runId: string; host?: string }, query = ""): string {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  if (run.host) params.set("host", run.host);
  const qs = params.toString();
  return `/runs/${encodeURIComponent(run.jobId)}/${encodeURIComponent(run.runId)}${qs ? `?${qs}` : ""}`;
}

export interface HostStatus {
  name: string;
  role: string;
  ssh: string | null;
  isSelf: boolean;
  health: HealthResponse | null;
  error: string | null;
  jobs: HostJobSummary[];
}

export interface HostsResponse {
  self: HostInfo | null;
  hosts: HostStatus[];
}

export interface JobResponse {
  id: string;
  name: string;
  schedule: string;
  directory: string;
  type: "claude" | "script";
  prompt?: string;
  command?: string;
  enabled: boolean;
  model?: string;
  timeout?: number;
  tags: string[];
  runs_on?: string | string[];
  isActive: boolean;
  cost: CostTotals;
  /** Host this entry belongs to, on a multi-host setup. */
  host?: string;
  /** Another host's job: shown, never triggered or toggled from here. */
  readOnly?: boolean;
}

export interface RunEvaluation {
  summary: string;
  severity: "ok" | "info" | "warning" | "critical";
  followUpNeeded: boolean;
  followUpReason: string | null;
  evaluatedAt: string;
  source?: "haiku" | "jev" | "jev+haiku" | "scheduler";
}

export interface RunResponse {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: "running" | "success" | "partial" | "failed" | "timeout" | "deferred" | "blocked" | "killed";
  trigger: "scheduled" | "manual" | "catchup";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
  decision?: RunDecision;
  catchupFor?: string;
  /** Inner Claude sessions a script run started (autopilot's b2c-toolkit runs). */
  innerSessions?: number;
  cost: RunCostSummary;
  configuredModel?: string;
  /** Host that ran it, on a multi-host setup. */
  host?: string;
}

export interface LogResponse {
  content: string;
  offset: number;
  done: boolean;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_API_BASE}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message =
      err &&
      typeof err === "object" &&
      "error" in err &&
      typeof err.error === "string"
        ? err.error
        : res.statusText;
    throw new ApiError(message || `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<HealthResponse> {
  return fetchApi("/health");
}

/** host: undefined for this Mac, "all", or a host name from scheduler.yaml. */
function hostQuery(host: string | undefined, prefix = "?"): string {
  return host ? `${prefix}host=${encodeURIComponent(host)}` : "";
}

export function getJobs(host?: string): Promise<JobResponse[]> {
  return fetchApi(`/jobs${hostQuery(host)}`);
}

export function getHosts(): Promise<HostsResponse> {
  return fetchApi("/hosts");
}

/** This daemon's headroom samples and usage hold (another host's are not read from here). */
export function getUsage(): Promise<UsageResponse> {
  return fetchApi("/usage");
}

export function getRuns(params?: {
  job?: string;
  status?: string;
  trigger?: RunResponse["trigger"];
  /** host (default): jobs placed on the selected Mac; all: every run it produced. */
  scope?: "host" | "all";
  /** undefined for this Mac, "all", or a host name from scheduler.yaml. */
  host?: string;
  /** Runs that started at or after `since` and before `until`. */
  since?: Date;
  until?: Date;
  limit?: number;
}): Promise<RunResponse[]> {
  const searchParams = new URLSearchParams();
  if (params?.host) searchParams.set("host", params.host);
  if (params?.since) searchParams.set("since", params.since.toISOString());
  if (params?.until) searchParams.set("until", params.until.toISOString());
  if (params?.job) searchParams.set("job", params.job);
  if (params?.status) searchParams.set("status", params.status);
  // A daemon started before this parameter existed ignores it, so callers also filter client-side.
  if (params?.trigger) searchParams.set("trigger", params.trigger);
  if (params?.scope) searchParams.set("scope", params.scope);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  const qs = searchParams.toString();
  return fetchApi(`/runs${qs ? `?${qs}` : ""}`);
}

export function getRunLog(
  jobId: string,
  runId: string,
  offset: number,
  host?: string,
  /** "session": the inner Claude sessions' text of a script run, instead of its output. */
  file?: "session",
): Promise<LogResponse> {
  return fetchApi(
    `/runs/${jobId}/${runId}/log?offset=${offset}${file ? `&file=${file}` : ""}${hostQuery(host, "&")}`,
  );
}

export function getRun(
  jobId: string,
  runId: string,
  signal?: AbortSignal,
  host?: string,
): Promise<RunResponse> {
  return fetchApi(
    `/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}${hostQuery(host)}`,
    { cache: "no-store", signal },
  );
}

export function getRunGraph(
  jobId: string,
  runId: string,
  signal?: AbortSignal,
  host?: string,
): Promise<RunGraph> {
  return fetchApi(
    `/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}/graph${hostQuery(host)}`,
    { cache: "no-store", signal },
  );
}

export function getCostStats(
  days: CostPeriod = 30,
  signal?: AbortSignal,
): Promise<CostStatsResponse> {
  return fetchApi(`/stats/costs?days=${days}`, { cache: "no-store", signal });
}

export function triggerJob(jobId: string): Promise<{ runId: string }> {
  return fetchApi(`/runs/${jobId}/trigger`, { method: "POST" });
}

export function setJobEnabled(
  jobId: string,
  enabled: boolean,
): Promise<{ ok: boolean; jobId: string; enabled: boolean }> {
  return fetchApi(`/jobs/${jobId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export interface ActivityDayBucket {
  date: string;
  sessions: number;
  toolCalls: number;
}

export interface ActivityStatsResponse {
  lifetime: {
    sessions: number;
    toolCalls: number;
    toolsByName: Record<string, number>;
  };
  daily: ActivityDayBucket[];
  /** Per host on a multi-host setup; the top level is their sum. */
  hosts?: {
    name: string;
    role: string;
    isSelf: boolean;
    lifetime: ActivityStatsResponse["lifetime"];
    daily: ActivityDayBucket[];
  }[];
}

export function getActivityStats(days = 30): Promise<ActivityStatsResponse> {
  return fetchApi(`/stats/activity?days=${days}`);
}

export interface CatchupQueueEntry {
  jobId: string;
  jobName: string;
  missedSlot: string;
  enqueuedAt: string;
}

export interface CatchupQueueInFlight {
  jobId: string;
  jobName: string;
  startedAt: string;
}

export interface CatchupQueueSnapshot {
  queued: CatchupQueueEntry[];
  inFlight: CatchupQueueInFlight | null;
}

export function getCatchupQueue(): Promise<CatchupQueueSnapshot> {
  return fetchApi("/queue/catchups");
}

export type ResearchSeverity = "critical" | "high" | "medium" | "low";

export interface ResearchFinding {
  id: string;
  severity: ResearchSeverity;
  category?: string;
  jobId?: string;
  title: string;
  currentBehavior?: string;
  proposal?: string;
  expectedImpact?: string;
}

export interface ResearchIndexEntry {
  date: string;
  hasFindings: boolean;
  totals?: Record<string, number>;
  summary?: string;
}

export interface ResearchReport {
  date: string;
  markdown: string | null;
  findings: ResearchFinding[] | null;
  totals: Record<string, number> | null;
  summary: string | null;
  generatedAt: string | null;
}

export function getResearchIndex(): Promise<{ reports: ResearchIndexEntry[] }> {
  return fetchApi("/research");
}

export function getResearchReport(date: string): Promise<ResearchReport> {
  return fetchApi(`/research/${date}`);
}
