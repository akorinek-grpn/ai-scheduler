import type { CostStatsResponse, CostTotals, RunCostSummary } from "../../shared/cost-types";

const DAEMON_API_BASE = "/api";

export type CostPeriod = 7 | 30 | 90;

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HealthResponse {
  status: string;
  pid: number;
  startedAt: string;
  activeJobs: string[];
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
  isActive: boolean;
  cost: CostTotals;
}

export interface RunEvaluation {
  summary: string;
  severity: "ok" | "info" | "warning" | "critical";
  followUpNeeded: boolean;
  followUpReason: string | null;
  evaluatedAt: string;
}

export interface RunResponse {
  jobId: string;
  runId: string;
  jobName: string;
  directory: string;
  status: "running" | "success" | "partial" | "failed" | "timeout";
  trigger: "scheduled" | "manual" | "catchup";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
  catchupFor?: string;
  cost: RunCostSummary;
  configuredModel?: string;
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
    const message = err && typeof err === "object" && "error" in err && typeof err.error === "string"
      ? err.error
      : res.statusText;
    throw new ApiError(message || `Request failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<HealthResponse> {
  return fetchApi("/health");
}

export function getJobs(): Promise<JobResponse[]> {
  return fetchApi("/jobs");
}

export function getRuns(params?: {
  job?: string;
  status?: string;
  limit?: number;
}): Promise<RunResponse[]> {
  const searchParams = new URLSearchParams();
  if (params?.job) searchParams.set("job", params.job);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  const qs = searchParams.toString();
  return fetchApi(`/runs${qs ? `?${qs}` : ""}`);
}

export function getRunLog(
  jobId: string,
  runId: string,
  offset: number,
): Promise<LogResponse> {
  return fetchApi(`/runs/${jobId}/${runId}/log?offset=${offset}`);
}

export function getRun(jobId: string, runId: string, signal?: AbortSignal): Promise<RunResponse> {
  return fetchApi(`/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}`, { cache: "no-store", signal });
}

export function getCostStats(days: CostPeriod = 30, signal?: AbortSignal): Promise<CostStatsResponse> {
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
