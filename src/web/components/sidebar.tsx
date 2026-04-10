"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getHealth, type HealthResponse } from "@/lib/api-client";
import { useNotificationContext } from "@/components/notification-provider";

const navItems = [
  { href: "/", label: "Dashboard", icon: "grid" },
  { href: "/timeline", label: "Timeline", icon: "timeline" },
  { href: "/jobs", label: "Jobs", icon: "list" },
  { href: "/runs", label: "Run History", icon: "clock" },
  { href: "/config", label: "Config", icon: "file" },
];

const icons: Record<string, string> = {
  grid: "M3 3h7v7H3V3zm11 0h7v7h-7V3zm-11 11h7v7H3v-7zm11 0h7v7h-7v-7z",
  timeline: "M3 6h18M3 6v12M21 6v12M3 18h18M8 6v12M13 6v12M18 6v12",
  list: "M3 4h18M3 8h18M3 12h14M3 16h10",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4v6l4 2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-2 1v5h5",
};

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const { permission, requestPermission } = useNotificationContext();

  useEffect(() => {
    const fetchHealth = () => {
      getHealth()
        .then(setHealth)
        .catch(() => setHealth(null));
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-border bg-background px-3 py-4">
      <div className="mb-6 flex items-center gap-2 px-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          AI
        </div>
        <span className="text-sm font-semibold">AI Scheduler</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-secondary text-secondary-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              }`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={icons[item.icon]} />
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-border pt-3">
        {/* Notification toggle */}
        <button
          onClick={permission === "default" ? requestPermission : undefined}
          className="flex items-center gap-2 px-3 py-1 w-full text-left rounded-md hover:bg-secondary/50 transition-colors"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={permission === "granted" ? "text-foreground" : "text-zinc-600"}
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
            {permission === "denied" && <path d="M1 1l22 22" />}
          </svg>
          <span className="text-xs text-muted-foreground">
            {permission === "granted"
              ? "Notifications on"
              : permission === "denied"
                ? "Notifications blocked"
                : "Enable notifications"}
          </span>
        </button>

        {/* Daemon status */}
        <div className="flex items-center gap-2 px-3 py-1">
          <div
            className={`h-2 w-2 rounded-full ${
              health ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]" : "bg-zinc-500"
            }`}
          />
          <span className="text-xs text-muted-foreground">
            {health ? "Daemon running" : "Daemon offline"}
          </span>
        </div>
        {health && (
          <div className="px-3 text-xs text-zinc-600">
            PID {health.pid}
          </div>
        )}
      </div>
    </aside>
  );
}
