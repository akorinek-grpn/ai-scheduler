"use client";

import { useCallback, useEffect, useState } from "react";
import { getHosts, type HostStatus, type HostsResponse } from "@/lib/api-client";
import { formatCronHuman } from "@/lib/format-cron";

function runsOnLabel(runsOn: string | string[]): string {
  return Array.isArray(runsOn) ? runsOn.join(", ") : runsOn;
}

function formatSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function HostCard({ host }: { host: HostStatus }): React.ReactElement {
  const online = host.health !== null;
  const stateLabel = online ? "Online" : host.ssh ? "Unreachable" : "Not checked";
  const dot = online ? "bg-green-500" : host.ssh ? "bg-red-500" : "bg-muted-foreground/50";
  const enabled = host.jobs.filter((j) => j.enabled).length;

  return (
    <section
      className="rounded border border-border bg-card p-3"
      aria-labelledby={`host-${host.name}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <h2 id={`host-${host.name}`} className="text-[13px] font-medium">
          {host.role}
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">{host.name}</span>
        {host.isSelf && (
          <span className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
            this Mac
          </span>
        )}
        <span className="ml-auto text-[11px]" role="status">
          {stateLabel}
        </span>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground">
        {host.health ? (
          <>
            <span className="font-mono">pid {host.health.pid}</span>
            <span className="mx-1.5 text-border">/</span>
            <span>up {formatSince(host.health.startedAt)}</span>
            <span className="mx-1.5 text-border">/</span>
            <span>
              {host.health.activeJobs.length > 0
                ? `running: ${host.health.activeJobs.join(", ")}`
                : "idle"}
            </span>
          </>
        ) : (
          <span>{host.error ?? "no daemon answered"}</span>
        )}
        {host.ssh && !host.isSelf && (
          <>
            <span className="mx-1.5 text-border">/</span>
            <span className="font-mono">ssh {host.ssh}</span>
          </>
        )}
      </div>

      <table className="w-full text-[12px]">
        <caption className="sr-only">
          Jobs placed on {host.role}: {enabled} enabled of {host.jobs.length}
        </caption>
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-1 pr-2 font-medium">Job</th>
            <th scope="col" className="py-1 pr-2 font-medium">Schedule</th>
            <th scope="col" className="py-1 font-medium">Runs on</th>
          </tr>
        </thead>
        <tbody>
          {host.jobs.map((job) => {
            const active = host.health?.activeJobs.includes(job.id) ?? false;
            return (
              <tr
                key={job.id}
                className={`border-t border-border/50 ${job.enabled ? "" : "text-muted-foreground"}`}
              >
                <td className="py-1 pr-2">
                  <span className="font-mono">{job.id}</span>
                  {!job.enabled && <span className="ml-1.5 text-[10px]">(off)</span>}
                  {active && (
                    <span className="ml-1.5 text-[10px] text-yellow-600 dark:text-yellow-400">
                      running
                    </span>
                  )}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">{formatCronHuman(job.schedule)}</td>
                <td className="py-1 font-mono text-[11px] text-muted-foreground">
                  {runsOnLabel(job.runs_on)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export default function HostsPage(): React.ReactElement {
  const [data, setData] = useState<HostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getHosts());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    // Each poll waits for the remote probes; a slow one is never overlapped.
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      await load();
      pending = false;
      if (disposed) return;
    };
    void poll();
    const interval = setInterval(() => void poll(), 15_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [load]);

  const offline = data?.hosts.filter((h) => h.health === null && h.ssh).length ?? 0;

  return (
    <main className="space-y-4 p-4">
      <div>
        <h1 className="text-[15px] font-semibold">Hosts</h1>
        <p className="text-[12px] text-muted-foreground">
          Every Mac in <span className="font-mono">scheduler.yaml</span> with the jobs placed on
          it and whether its daemon answers. Checked every 15 seconds.
        </p>
      </div>

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {data && data.hosts.length === 0 && !error && (
        <p className="text-[12px] text-muted-foreground">
          This scheduler runs on one Mac. Declare <span className="font-mono">hosts:</span> and
          give each job a <span className="font-mono">runs_on:</span> to spread jobs over several.
        </p>
      )}

      {offline > 0 && (
        <p className="text-[12px] text-red-600 dark:text-red-400" role="status">
          {offline === 1 ? "One daemon is not answering." : `${offline} daemons are not answering.`}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {data?.hosts.map((host) => <HostCard key={host.name} host={host} />)}
      </div>
    </main>
  );
}
