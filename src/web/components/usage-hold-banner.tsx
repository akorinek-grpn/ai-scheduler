"use client";

import { useEffect, useState } from "react";
import { getHealth, type HealthResponse, type UsageHoldInfo } from "@/lib/api-client";
import { useHostView } from "@/components/host-view";

/** "2h 14m" until `until`, or "any moment" once it has passed. */
export function formatRemaining(until: string, now: number): string {
  const ms = new Date(until).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface HeldHost {
  role: string;
  isSelf: boolean;
  hold: UsageHoldInfo;
}

/**
 * Band under the host banner while a Mac's Claude jobs are held: its account's usage window is
 * exhausted (data/usage-hold.json on that daemon). Amber, so it reads apart from the host
 * colours. Every host's hold comes with its health (this Mac's directly, the others over ssh).
 */
export function UsageHoldBanner(): React.ReactElement | null {
  const { hosts, multi } = useHostView();
  const [self, setSelf] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    const poll = (): void => {
      getHealth()
        .then((h) => {
          if (!disposed) setSelf(h);
        })
        .catch(() => {
          // keep the last answer
        });
    };
    poll();
    const pollTimer = setInterval(poll, 30_000);
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      disposed = true;
      clearInterval(pollTimer);
      clearInterval(clock);
    };
  }, []);

  const held: HeldHost[] = multi
    ? hosts.flatMap((h) =>
        h.health?.usageHold ? [{ role: h.role, isSelf: h.isSelf, hold: h.health.usageHold }] : [],
      )
    : self?.usageHold
      ? [{ role: self.host?.role ?? "this Mac", isSelf: true, hold: self.usageHold }]
      : [];
  if (held.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 space-y-1 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] text-foreground"
      style={{ borderLeft: "6px solid var(--color-amber-500, #f59e0b)" }}
    >
      {held.map(({ role, isSelf, hold }) => (
        <p key={role} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold">
            Claude usage limit on {role}
            {isSelf ? " (this Mac)" : ""}:
          </span>
          <span>
            the {hold.kind === "weekly" ? "7-day" : "5-hour"} window is used up. Jobs that start a Claude
            session resume {formatLocal(hold.until)} (in {formatRemaining(hold.until, now)});
            other scripts keep running.
          </span>
          <span className="text-muted-foreground">
            {hold.skipped === 1 ? "1 tick skipped" : `${hold.skipped} ticks skipped`}
            {hold.jobId ? ` · reported by ${hold.jobId}` : ""}
          </span>
        </p>
      ))}
    </div>
  );
}
