"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const severityStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
  ok: { border: "border-green-500/30", bg: "bg-green-500/5", text: "text-green-400", icon: "\u2713" },
  info: { border: "border-blue-500/30", bg: "bg-blue-500/5", text: "text-blue-400", icon: "\u2139" },
  warning: { border: "border-amber-500/30", bg: "bg-amber-500/5", text: "text-amber-400", icon: "\u26A0" },
  critical: { border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-400", icon: "!!" },
};

export function AiInsights({ runs }: AiInsightsProps): React.ReactElement {
  const evaluatedRuns = runs.filter((r) => r.evaluation);
  const needsFollowUp = evaluatedRuns.filter((r) => r.evaluation?.followUpNeeded);
  const criticalOrWarning = evaluatedRuns.filter(
    (r) => r.evaluation?.severity === "critical" || r.evaluation?.severity === "warning"
  );

  // Show the most important items: follow-ups first, then by severity
  const highlightRuns = [...new Map(
    [...needsFollowUp, ...criticalOrWarning]
      .sort((a, b) => severityOrder[a.evaluation!.severity] - severityOrder[b.evaluation!.severity])
      .map((r) => [`${r.jobId}-${r.runId}`, r])
  ).values()].slice(0, 5);

  if (evaluatedRuns.length === 0) {
    return <></>;
  }

  const okCount = evaluatedRuns.filter((r) => r.evaluation?.severity === "ok").length;
  const infoCount = evaluatedRuns.filter((r) => r.evaluation?.severity === "info").length;
  const warnCount = evaluatedRuns.filter((r) => r.evaluation?.severity === "warning").length;
  const critCount = evaluatedRuns.filter((r) => r.evaluation?.severity === "critical").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-sm font-semibold">AI Insights</CardTitle>
          <div className="flex items-center gap-3 flex-wrap">
            {critCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-red-400">
                <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                {critCount} critical
              </span>
            )}
            {warnCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                {warnCount} warning
              </span>
            )}
            {infoCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-blue-400">
                <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
                {infoCount} info
              </span>
            )}
            {okCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-green-400">
                <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                {okCount} ok
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {highlightRuns.length > 0 ? (
          <div className="space-y-2">
            {highlightRuns.map((run) => {
              const ev = run.evaluation!;
              const style = severityStyles[ev.severity] ?? severityStyles.info;
              return (
                <Link
                  key={`${run.jobId}-${run.runId}`}
                  href={`/runs/${run.jobId}/${run.runId}`}
                  className="block"
                >
                  <div
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-secondary/50 ${style.border} ${style.bg}`}
                  >
                    <span className={`mt-0.5 text-sm font-medium ${style.text} shrink-0`}>{style.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-xs font-medium truncate max-w-[200px]">{run.jobName}</span>
                        <Badge variant="outline" className={`text-[10px] ${style.text} ${style.border}`}>
                          {ev.severity}
                        </Badge>
                        {ev.followUpNeeded && (
                          <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">
                            follow-up needed
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{ev.summary}</p>
                      {ev.followUpReason && (
                        <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-1">{ev.followUpReason}</p>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                      {formatTimeAgo(run.startedAt)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground text-center py-4">
            All recent runs evaluated as OK
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
