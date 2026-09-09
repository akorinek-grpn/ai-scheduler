"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { getResearchIndex, type ResearchIndexEntry } from "@/lib/api-client";

const severityStyles: Record<string, string> = {
  critical: "border-red-500/50 text-red-500",
  high: "border-amber-500/50 text-amber-500",
  medium: "border-blue-500/50 text-blue-500",
  low: "border-muted-foreground/40 text-muted-foreground",
};

const SEVERITY_KEYS = ["critical", "high", "medium", "low"] as const;

export default function ResearchIndexPage(): React.ReactElement {
  const [reports, setReports] = useState<ResearchIndexEntry[] | null>(null);

  useEffect(() => {
    getResearchIndex()
      .then(({ reports: r }) => setReports(r))
      .catch(() => setReports([]));
  }, []);

  return (
    <div className="space-y-4 max-w-3xl">
      <header className="space-y-1">
        <h1 className="text-[14px] font-semibold">Research</h1>
        <p className="text-[12px] text-muted-foreground">
          Weekly analysis reports from the{" "}
          <span className="font-mono">ai-researcher</span> job. Findings are
          proposals only — apply manually after review.
        </p>
      </header>

      {reports === null && (
        <p className="text-[12px] text-muted-foreground">Loading&hellip;</p>
      )}

      {reports?.length === 0 && (
        <div className="rounded border border-border/50 p-4 text-[12px] text-muted-foreground">
          No reports yet. The next ai-researcher run is Sunday 05:00.
        </div>
      )}

      {reports && reports.length > 0 && (
        <ul className="space-y-1">
          {reports.map((r) => (
            <li key={r.date}>
              <Link
                href={`/research/${r.date}`}
                className="flex items-baseline gap-3 rounded border border-border/30 px-3 py-2 transition-colors hover:bg-secondary/50 hover:border-border"
              >
                <span className="font-mono text-[12px] text-foreground">
                  {r.date}
                </span>
                {r.totals && (
                  <span className="flex items-center gap-1">
                    {SEVERITY_KEYS.map((s) =>
                      r.totals?.[s] ? (
                        <Badge
                          key={s}
                          variant="outline"
                          className={`text-[10px] ${severityStyles[s]}`}
                        >
                          {r.totals[s]} {s}
                        </Badge>
                      ) : null,
                    )}
                  </span>
                )}
                <span className="flex-1 text-[12px] text-muted-foreground truncate">
                  {r.summary ?? (r.hasFindings ? "" : "(markdown only)")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
