const DAEMON_API_BASE = "/api";

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
  status: "running" | "success" | "failed" | "timeout";
  trigger: "scheduled" | "manual";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  evaluation?: RunEvaluation;
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
    throw new Error((err as Record<string, string>).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function getHealth(): Promise<HealthResponse> {
  return fetchApi("/health");
}

export function getJobs(): Promise<JobResponse[]> {
  return fetchApi("/jobs");
}

export function getRuns(params?: { job?: string; status?: string; limit?: number }): Promise<RunResponse[]> {
  const searchParams = new URLSearchParams();
  if (params?.job) searchParams.set("job", params.job);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  const qs = searchParams.toString();
  return fetchApi(`/runs${qs ? `?${qs}` : ""}`);
}

export function getRunLog(jobId: string, runId: string, offset: number): Promise<LogResponse> {
  return fetchApi(`/runs/${jobId}/${runId}/log?offset=${offset}`);
}

export function triggerJob(jobId: string): Promise<{ runId: string }> {
  return fetchApi(`/runs/${jobId}/trigger`, { method: "POST" });
}
