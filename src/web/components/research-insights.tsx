"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  getResearchIndex,
  getResearchReport,
  type ResearchFinding,
  type ResearchIndexEntry,
} from "@/lib/api-client";

const severityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const severityStyles: Record<string, string> = {
  critical: "border-red-500/50 text-red-500",
  high: "border-amber-500/50 text-amber-500",
  medium: "border-blue-500/50 text-blue-500",
  low: "border-muted-foreground/40 text-muted-foreground",
};

function relativeDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

export function ResearchInsights(): React.ReactElement | null {
  const [latest, setLatest] = useState<ResearchIndexEntry | null>(null);
  const [findings, setFindings] = useState<ResearchFinding[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { reports } = await getResearchIndex();
        if (cancelled || reports.length === 0) return;
        const top = reports[0];
        setLatest(top);
        if (top.hasFindings) {
          const report = await getResearchReport(top.date);
          if (!cancelled) setFindings(report.findings);
        }
      } catch {
        // silently no-op — no research yet is fine
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (!latest) return null;

  const topFindings = findings
    ? [...findings]
        .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
        .slice(0, 3)
    : [];

  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          AI Researcher
        </h2>
        <span className="text-[11px] text-muted-foreground">
          latest report {relativeDate(latest.date)} &middot; {latest.date}
        </span>
        <div className="flex-1 border-t border-border/30 ml-2 mt-0.5" />
        <Link
          href={`/research/${latest.date}`}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          view full report &rarr;
        </Link>
      </div>

      {latest.summary && (
        <p className="text-[12px] text-muted-foreground mb-2">
          {latest.summary}
        </p>
      )}

      {topFindings.length > 0 ? (
        <div className="space-y-1">
          {topFindings.map((f) => (
            <Link
              key={f.id}
              href={`/research/${latest.date}#${f.id}`}
              className="flex items-baseline gap-2 rounded px-2 py-1.5 transition-colors hover:bg-secondary/50 group"
            >
              <Badge
                variant="outline"
                className={`text-[10px] ${severityStyles[f.severity] ?? ""}`}
              >
                {f.severity}
              </Badge>
              {f.jobId && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {f.jobId}
                </span>
              )}
              <span className="text-[13px] text-foreground group-hover:underline truncate">
                {f.title}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <Link
          href={`/research/${latest.date}`}
          className="block rounded px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
        >
          Open the report &rarr;
        </Link>
      )}
    </section>
  );
}
