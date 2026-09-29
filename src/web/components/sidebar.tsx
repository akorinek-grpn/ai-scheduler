"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getCatchupQueue, getHealth, type HealthResponse } from "@/lib/api-client";
import { CATCHUP_RUNS_HREF, pendingCatchupCount } from "@/lib/catchup-runs";
import { useNotificationContext } from "@/components/notification-provider";

const navItems = [
  { href: "/", label: "Dashboard", key: "D" },
  { href: "/timeline", label: "Timeline", key: "T" },
  { href: "/jobs", label: "Jobs", key: "J" },
  { href: "/runs", label: "Runs", key: "R" },
  { href: "/research", label: "Research", key: "X" },
  { href: "/config", label: "Config", key: "C" },
];

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catchupCount, setCatchupCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const { permission, requestPermission } = useNotificationContext();

  useEffect(() => {
    let disposed = false;
    let pending = false;
    // One poll reads health and the catch-up queue; a slow poll is never overlapped.
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      const [nextHealth, queue] = await Promise.all([
        getHealth().catch(() => null),
        getCatchupQueue().catch(() => null),
      ]);
      pending = false;
      if (disposed) return;
      setHealth(nextHealth);
      setCatchupCount(pendingCatchupCount(queue));
    };
    void poll();
    const interval = setInterval(() => void poll(), 10_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setIsOpen(true)}
        className="fixed top-2 left-2 z-40 flex h-8 w-8 items-center justify-center rounded bg-secondary md:hidden"
        aria-label="Open navigation"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm md:hidden"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex h-screen w-48 flex-col border-r border-border bg-sidebar
          transition-transform duration-150 ease-out
          md:static md:translate-x-0
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
          <span className="font-mono text-[11px] font-bold tracking-tight text-primary">
            AI:SCHED
          </span>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-px py-2 px-2">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            const link = (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-[13px] transition-colors ${
                  isActive
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
              >
                <span className="font-mono text-[10px] text-muted-foreground w-3">
                  {item.key}
                </span>
                {item.label}
              </Link>
            );
            if (item.href !== "/runs") return link;
            const catchupLabel = `${catchupCount} catch-up ${catchupCount === 1 ? "run" : "runs"} waiting or running`;
            // Runs keeps one wrapper so its link is not remounted (losing focus) when the pill comes and goes.
            // The pill is a sibling link over the row's right end (links cannot nest), shown only while
            // catch-ups are waiting or running.
            return (
              <div key={item.href} className="relative">
                {link}
                {catchupCount > 0 && (
                  <Link
                    href={CATCHUP_RUNS_HREF}
                    aria-label={catchupLabel}
                    title={catchupLabel}
                    className="absolute right-1 top-1/2 inline-flex h-[24px] min-w-[24px] -translate-y-1/2 items-center justify-center gap-0.5 rounded-full border border-blue-700/40 px-1.5 font-mono text-[10px] tabular-nums text-blue-700 transition-colors hover:bg-secondary dark:border-blue-400/40 dark:text-blue-400"
                  >
                    <span aria-hidden="true">↻</span>
                    {catchupCount}
                  </Link>
                )}
              </div>
            );
          })}
        </nav>

        {/* Status bar at bottom */}
        <div className="border-t border-border px-3 py-2 space-y-1">
          <button
            onClick={permission === "default" ? requestPermission : undefined}
            className="flex items-center gap-2 w-full text-left rounded px-1 py-0.5 hover:bg-secondary/60 transition-colors"
            aria-label={
              permission === "granted"
                ? "Notifications enabled"
                : permission === "denied"
                  ? "Notifications blocked"
                  : "Enable notifications"
            }
          >
            <span
              className={`text-[10px] ${permission === "granted" ? "text-foreground" : "text-muted-foreground"}`}
            >
              {permission === "granted"
                ? "\u266A"
                : permission === "denied"
                  ? "\u2715"
                  : "\u25CB"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {permission === "granted"
                ? "Notifs on"
                : permission === "denied"
                  ? "Blocked"
                  : "Notifications"}
            </span>
          </button>

          <div
            className="flex items-center gap-2 px-1"
            role="status"
            aria-label={health ? "Daemon running" : "Daemon offline"}
          >
            <div
              className={`h-1.5 w-1.5 rounded-full ${health ? "bg-green-500" : "bg-muted-foreground/50"}`}
            />
            <span className="text-[11px] font-mono text-muted-foreground">
              {health ? `pid ${health.pid}` : "offline"}
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
