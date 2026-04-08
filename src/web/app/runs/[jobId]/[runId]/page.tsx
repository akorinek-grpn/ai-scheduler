"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogViewer } from "@/components/log-viewer";
import { getRuns, type RunResponse } from "@/lib/api-client";

export default function RunDetailPage(): React.ReactElement {
  const params = useParams<{ jobId: string; runId: string }>();
  const router = useRouter();
  const [run, setRun] = useState<RunResponse | null>(null);

  useEffect(() => {
    getRuns({ job: params.jobId })
      .then((runs) => {
        const found = runs.find((r) => r.runId === params.runId);
        if (found) setRun(found);
      })
      .catch(() => {});
  }, [params.jobId, params.runId]);

  const statusColors: Record<string, string> = {
    running: "border-yellow-500/50 text-yellow-500",
    success: "border-green-500/50 text-green-500",
    failed: "border-red-500/50 text-red-500",
    timeout: "border-orange-500/50 text-orange-500",
  };

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

      <LogViewer jobId={params.jobId} runId={params.runId} />
    </div>
  );
}
