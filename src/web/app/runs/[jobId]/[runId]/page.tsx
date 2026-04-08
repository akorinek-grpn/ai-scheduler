"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LogViewer } from "@/components/log-viewer";
import { getRuns, type RunResponse } from "@/lib/api-client";

export default function RunDetailPage(): React.ReactElement {
  const params = useParams<{ jobId: string; runId: string }>();
  const router = useRouter();
  const [run, setRun] = useState<RunResponse | null>(null);

  useEffect(() => {
    const poll = () => {
      getRuns({ job: params.jobId })
        .then((runs) => {
          const found = runs.find((r) => r.runId === params.runId);
          if (found) setRun(found);
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, [params.jobId, params.runId]);

  const statusColors: Record<string, string> = {
    running: "border-yellow-500/50 text-yellow-500",
    success: "border-green-500/50 text-green-500",
    failed: "border-red-500/50 text-red-500",
    timeout: "border-orange-500/50 text-orange-500",
  };

  const evalStyles: Record<string, { border: string; bg: string; text: string; icon: string }> = {
    ok: { border: "border-green-500/30", bg: "bg-green-500/5", text: "text-green-400", icon: "✓" },
    info: { border: "border-blue-500/30", bg: "bg-blue-500/5", text: "text-blue-400", icon: "ℹ" },
    warning: { border: "border-amber-500/30", bg: "bg-amber-500/5", text: "text-amber-400", icon: "⚠" },
    critical: { border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-400", icon: "!!" },
  };

  const evalData = run?.evaluation;
  const es = evalData ? evalStyles[evalData.severity] ?? evalStyles.info : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          ← Back
        </Button>
        <div>
          <h1 className="text-lg font-semibold">
            {run?.jobName ?? params.jobId}
          </h1>
          <p className="text-xs text-muted-foreground font-mono">{params.runId}</p>
        </div>
        {run && (
          <Badge variant="outline" className={statusColors[run.status] ?? ""}>
            {run.status}
          </Badge>
        )}
        {run?.finishedAt && (
          <span className="text-xs text-muted-foreground ml-auto">
            Exit code: {run.exitCode}
          </span>
        )}
      </div>

      {evalData && es && (
        <Card className={`mb-4 ${es.border} ${es.bg}`}>
          <CardContent className="py-3">
            <div className="flex items-start gap-3">
              <span className={`text-lg ${es.text}`}>{es.icon}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-sm font-medium ${es.text}`}>
                    {evalData.severity.charAt(0).toUpperCase() + evalData.severity.slice(1)}
                    {evalData.followUpNeeded && " — Follow-up needed"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{evalData.summary}</p>
                {evalData.followUpReason && (
                  <p className="text-sm mt-1">
                    <span className="text-muted-foreground">Reason: </span>
                    {evalData.followUpReason}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <LogViewer jobId={params.jobId} runId={params.runId} />
    </div>
  );
}
