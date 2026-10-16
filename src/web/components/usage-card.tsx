"use client";

import { useEffect, useState } from "react";
import { getUsage, type UsageResponse, type UsageWindow } from "@/lib/api-client";
import { useHostView } from "@/components/host-view";
import { formatRemaining } from "@/components/usage-hold-banner";

const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

function formatAge(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function barColor(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return "bg-green-500";
}

function WindowRow({ id, window, now }: { id: string; window: UsageWindow; now: number }): React.ReactElement {
  const percent = window.utilization_percent;
  const clamped = percent === null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-medium">{window.label}</span>
        <span className="font-mono tabular-nums">
          {percent === null ? "?" : `${Math.round(percent)}%`}
          {window.assumed_fraction ? <span className="ml-1 text-[10px] text-muted-foreground">(read as a fraction)</span> : null}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded bg-secondary"
        role="progressbar"
        aria-label={`${window.label} window used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped ?? undefined}
        aria-valuetext={percent === null ? "unknown" : `${Math.round(percent)} percent`}
      >
        {clamped !== null && <div className={`h-full ${barColor(clamped)}`} style={{ width: `${clamped}%` }} />}
      </div>
      <div className="text-[11px] text-muted-foreground" data-window={id}>
        {window.resets_at
          ? `resets ${formatLocal(window.resets_at)} (in ${formatRemaining(window.resets_at, now)})`
          : "reset time not in the sample"}
      </div>
    </div>
  );
}

/**
 * The account's usage window as the usage-headroom job last sampled it (GET /api/usage).
 * Report-only: the card shows headroom, it throttles nothing. Hidden while another host is on
 * screen, whose samples are not read from here.
 */
export function UsageCard(): React.ReactElement | null {
  const { isOther } = useHostView();
  const [data, setData] = useState<UsageResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    const load = (): void => {
      getUsage()
        .then((d) => {
          if (!disposed) {
            setData(d);
            setNow(Date.now());
          }
        })
        .catch(() => {
          // keep the last answer
        });
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  if (isOther) return null;
  const latest = data?.latest ?? null;
  const windows = latest
    ? Object.entries(latest.windows).sort(
        ([a], [b]) => (WINDOW_ORDER.indexOf(a) + 1 || 99) - (WINDOW_ORDER.indexOf(b) + 1 || 99),
      )
    : [];

  return (
    <section className="rounded border border-border p-4 space-y-3" aria-label="Claude usage window">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Claude usage window
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {latest ? `sampled ${formatAge(latest.at, now)}` : "no sample yet"} · every 30 min · report-only
        </span>
      </div>

      {!latest && (
        <p className="text-[12px] text-muted-foreground">
          The usage-headroom job has not written a sample yet (data/usage/latest.json).
        </p>
      )}
      {latest && latest.status !== "ok" && (
        <p className="text-[12px] text-amber-600 dark:text-amber-400" role="status">
          Unavailable: {latest.error ?? "no detail"}
        </p>
      )}
      {latest && latest.status === "ok" && windows.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          The sample had no window the gauge knows; the raw response is kept in data/usage/latest.json.
        </p>
      )}
      {windows.length > 0 && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
          {windows.map(([id, window]) => (
            <WindowRow key={id} id={id} window={window} now={now} />
          ))}
        </div>
      )}

      {data?.hold && (
        <p className="text-[12px] text-amber-600 dark:text-amber-400" role="status">
          Held: the {data.hold.kind === "weekly" ? "7-day" : "5-hour"} limit was hit; Claude jobs resume in{" "}
          {formatRemaining(data.hold.until, now)}.
        </p>
      )}
    </section>
  );
}
