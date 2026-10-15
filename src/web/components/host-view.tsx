"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getHosts, type HostInfo, type HostStatus } from "../lib/api-client";

/**
 * Which host's data the UI shows, on a multi-host setup (scheduler.yaml `hosts`). This Mac is
 * fully interactive; another host is read-only, from the data its daemon mirrors here. Each
 * host keeps one color (--host-N, by scheduler.yaml order) wherever it appears.
 */
const STORAGE_KEY = "ai-scheduler:host-view";

export interface HostViewValue {
  /** scheduler.yaml order; empty on a single-machine setup. */
  hosts: HostStatus[];
  self: HostInfo | null;
  multi: boolean;
  /** "self", "all", or a host name. */
  view: string;
  setView: (view: string) => void;
  /** `host` for the API: undefined for this Mac. */
  hostParam: string | undefined;
  /** The single host on screen (this Mac for "self"), or null for "all". */
  viewed: HostStatus | null;
  /** Viewing a host other than this one: read-only. */
  isOther: boolean;
  colorOf: (name?: string) => string;
  roleOf: (name?: string) => string;
  isSelfHost: (name?: string) => boolean;
}

const HostViewContext = createContext<HostViewValue | null>(null);

function readStoredView(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "self";
  } catch {
    return "self";
  }
}

export function HostViewProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [hosts, setHosts] = useState<HostStatus[]>([]);
  const [self, setSelf] = useState<HostInfo | null>(null);
  const [view, setViewState] = useState("self");

  useEffect(() => {
    setViewState(readStoredView());
    let disposed = false;
    let pending = false;
    // Health of the other hosts comes over ssh; a slow poll is never overlapped.
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const data = await getHosts();
        if (!disposed) {
          setHosts(data.hosts);
          setSelf(data.self);
        }
      } catch {
        // keep the last answer
      } finally {
        pending = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 30_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  const setView = useCallback((next: string) => {
    setViewState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }, []);

  const value = useMemo<HostViewValue>(() => {
    const multi = hosts.length > 1;
    const find = (name?: string) =>
      name ? hosts.find((h) => h.name.toLowerCase() === name.toLowerCase()) : undefined;
    const selfHost = hosts.find((h) => h.isSelf) ?? null;
    // A stored view naming a host the file no longer has falls back to this Mac.
    const effective = !multi ? "self" : view === "all" || find(view) ? view : "self";
    const viewed = effective === "all" ? null : effective === "self" ? selfHost : find(effective) ?? null;
    const isOther = Boolean(viewed && !viewed.isSelf);
    return {
      hosts,
      self,
      multi,
      view: effective,
      setView,
      hostParam: effective === "all" ? "all" : isOther ? viewed?.name : undefined,
      viewed,
      isOther,
      colorOf: (name) => {
        const index = hosts.findIndex((h) => h.name.toLowerCase() === name?.toLowerCase());
        return index >= 0 && index < 2 ? `var(--host-${index + 1})` : "var(--color-muted-foreground)";
      },
      roleOf: (name) => find(name)?.role ?? name ?? "",
      isSelfHost: (name) => !name || Boolean(find(name)?.isSelf),
    };
  }, [hosts, self, view, setView]);

  return <HostViewContext.Provider value={value}>{children}</HostViewContext.Provider>;
}

// Outside the provider (tests, a single-machine setup before /api/hosts answers): one host.
const SINGLE_HOST: HostViewValue = {
  hosts: [],
  self: null,
  multi: false,
  view: "self",
  setView: () => {},
  hostParam: undefined,
  viewed: null,
  isOther: false,
  colorOf: () => "var(--color-muted-foreground)",
  roleOf: (name) => name ?? "",
  isSelfHost: () => true,
};

export function useHostView(): HostViewValue {
  return useContext(HostViewContext) ?? SINGLE_HOST;
}

/**
 * Colored dot + role name; the text carries the identity, the dot only echoes it. Shown only
 * while both hosts are on screen (one host is named by the banner), or `always` for views that
 * mix hosts regardless, like costs. `compact` keeps the role's last two parts for dense rows.
 */
export function HostBadge({
  name,
  className = "",
  always = false,
  compact = false,
}: {
  name?: string;
  className?: string;
  always?: boolean;
  compact?: boolean;
}): React.ReactElement | null {
  const { multi, view, colorOf, roleOf, isSelfHost } = useHostView();
  if (!multi || !name || (view !== "all" && !always)) return null;
  const role = roleOf(name);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground ${className}`}
      title={`${role} (${name})${isSelfHost(name) ? " · this Mac" : " · read-only"}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(name) }} aria-hidden="true" />
      {compact ? role.split("-").slice(-2).join("-") : role}
    </span>
  );
}

/** Host names a job's `runs_on` places it on (a role, a list of roles, or "all"). */
export function placedHostNames(hosts: HostStatus[], runsOn?: string | string[]): string[] {
  if (!runsOn || runsOn === "all") return hosts.map((h) => h.name);
  const roles = Array.isArray(runsOn) ? runsOn : [runsOn];
  return hosts.filter((h) => roles.includes(h.role)).map((h) => h.name);
}

/**
 * Where scheduler.yaml schedules a job, in every view: one colored dot per Mac and its role,
 * or "both Macs". Hidden on a single-machine setup.
 */
export function PlacementBadge({ runsOn, className = "" }: { runsOn?: string | string[]; className?: string }): React.ReactElement | null {
  const { multi, hosts, colorOf } = useHostView();
  if (!multi || !runsOn) return null;
  const placed = hosts.filter((h) => placedHostNames(hosts, runsOn).includes(h.name));
  const label =
    placed.length === hosts.length
      ? hosts.length === 2 ? "both Macs" : "every Mac"
      : placed.map((h) => h.role).join(", ") || (Array.isArray(runsOn) ? runsOn.join(", ") : runsOn);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground ${className}`}
      title={`Scheduled on ${placed.map((h) => `${h.role} (${h.name})`).join(" and ") || label}`}
    >
      <span className="flex gap-0.5" aria-hidden="true">
        {placed.map((h) => (
          <span key={h.name} className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(h.name) }} />
        ))}
      </span>
      runs on {label}
    </span>
  );
}

/** Sidebar control: this Mac, another host, or both. Hidden on a single-machine setup. */
export function HostSwitcher(): React.ReactElement | null {
  const { multi, hosts, view, setView, colorOf } = useHostView();
  if (!multi) return null;
  const options = [
    ...hosts.map((h) => ({ value: h.isSelf ? "self" : h.name, label: h.role, sub: h.isSelf ? "this Mac" : "read-only", color: colorOf(h.name) })),
    { value: "all", label: "Both", sub: "side by side", color: null as string | null },
  ];
  return (
    <div className="border-t border-border px-2 py-2" role="radiogroup" aria-label="Show data from">
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">Showing</div>
      {options.map((option) => {
        const checked = view === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => setView(option.value)}
            className={`flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] transition-colors ${
              checked ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
          >
            {option.color ? (
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: option.color }} aria-hidden="true" />
            ) : (
              <span className="flex shrink-0" aria-hidden="true">
                <span className="h-2.5 w-1.5 rounded-l-full" style={{ backgroundColor: "var(--host-1)" }} />
                <span className="h-2.5 w-1.5 rounded-r-full" style={{ backgroundColor: "var(--host-2)" }} />
              </span>
            )}
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate" title={option.label}>{option.label}</span>
              <span className="block text-[10px] font-normal text-muted-foreground">{option.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Band across the top of every page while another host, or both, are on screen. */
export function HostBanner(): React.ReactElement | null {
  const { multi, view, viewed, isOther, hosts, setView, colorOf } = useHostView();
  if (!multi || view === "self") return null;
  const color = isOther && viewed ? colorOf(viewed.name) : "var(--color-border)";
  return (
    <div
      role="status"
      className="sticky -top-4 z-20 -mx-4 -mt-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-[12px] md:-top-6 md:-mx-6 md:-mt-6 md:px-6"
      style={{
        borderLeft: `6px solid ${color}`,
        backgroundColor: isOther ? `color-mix(in oklch, ${color} 14%, var(--color-card))` : "var(--color-card)",
      }}
    >
      {isOther && viewed ? (
        <>
          <span className="font-semibold text-foreground">Viewing {viewed.role}</span>
          <span className="font-mono text-muted-foreground">{viewed.name}</span>
          <span className="rounded border border-border bg-card px-1.5 py-px text-[11px] text-foreground">read-only</span>
          <span className="text-muted-foreground">
            Runs are copied every 5 minutes;{" "}
            {viewed.health
              ? "its daemon is online"
              : viewed.ssh
                ? `its daemon is not answering (${viewed.error ?? "unknown"})`
                : "its daemon is not checked from this Mac, which has no ssh access to it"}
            .
          </span>
        </>
      ) : (
        <>
          <span className="font-semibold text-foreground">Showing both Macs</span>
          {hosts.map((h) => (
            <span key={h.name} className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorOf(h.name) }} aria-hidden="true" />
              {h.role}
              {h.isSelf ? " (this Mac)" : " (read-only)"}
            </span>
          ))}
        </>
      )}
      <button
        type="button"
        onClick={() => setView("self")}
        className="ml-auto rounded border border-border bg-card px-2 py-0.5 text-[11px] text-foreground hover:bg-secondary"
      >
        Back to this Mac
      </button>
    </div>
  );
}
