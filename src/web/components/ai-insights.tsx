"use client";

import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import type { RunResponse } from "@/lib/api-client";

interface AiInsightsProps {
  runs: RunResponse[];
}

const severityOrder: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

const severityText: Record<string, string> = {
  ok: "text-green-500",
  info: "text-blue-500",
  warning: "text-amber-500",
  critical: "text-red-500",
};

const severityIcon: Record<string, string> = {
  ok: "\u2713",
  info: "\u2139",
  warning: "\u26A0",
  critical: "!!",
};

export function AiInsights({ runs }: AiInsightsProps): React.ReactElement {
  const evaluatedRuns = runs.filter((r) => r.evaluation);
  const needsFollowUp = evaluatedRuns.filter((r) => r.evaluation?.followUpNeeded);
  const criticalOrWarning = evaluatedRuns.filter(
    (r) => r.evaluation?.severity === "critical" || r.evaluation?.severity === "warning"
  );

  const highlightRuns = [...new Map(
    [...needsFollowUp, ...criticalOrWarning]
      .sort((a, b) => severityOrder[a.evaluation!.severity] - severityOrder[b.evaluation!.severity])
      .map((r) => [`${r.jobId}-${r.runId}`, r])
  ).values()].slice(0, 4);

  if (highlightRuns.length === 0) {
    return <></>;
  }

  return (
    <section>
      <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Attention</h2>
      <div className="space-y-1">
        {highlightRuns.map((run) => {
          const ev = run.evaluation!;
          const color = severityText[ev.severity] ?? "text-muted-foreground";
          return (
            <Link
              key={`${run.jobId}-${run.runId}`}
              href={`/runs/${run.jobId}/${run.runId}`}
              className="flex items-baseline gap-2 rounded px-2 py-1.5 transition-colors hover:bg-secondary/50 group"
            >
              <span className={`text-[12px] font-medium shrink-0 ${color}`}>{severityIcon[ev.severity]}</span>
              <span className="text-[13px] font-medium truncate max-w-[180px] group-hover:text-foreground">{run.jobName}</span>
              <Badge variant="outline" className={`text-[10px] shrink-0 ${color}`}>
                {ev.severity}
              </Badge>
              {ev.followUpNeeded && (
                <span className="text-[10px] text-amber-500 shrink-0">follow-up</span>
              )}
              <span className="text-[12px] text-muted-foreground/60 truncate flex-1 min-w-0">{ev.summary}</span>
              <span className="text-[10px] text-muted-foreground shrink-0">{formatTimeAgo(run.startedAt)}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
