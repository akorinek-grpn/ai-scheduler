"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LogViewer } from "@/components/log-viewer";
import { RunDiagram } from "@/components/run-diagram";
import { RunCostDetails } from "@/components/run-cost-details";
import { CatchupBadge } from "@/components/catchup-badge";
import { ApiError, getRun, getRuns, runHref, type RunResponse } from "@/lib/api-client";
import { useHostView } from "@/components/host-view";

type RunView = "output" | "session" | "diagram";

function parseRunView(value: string | null): RunView {
  return value === "diagram" || value === "session" ? value : "output";
}

export default function RunDetailPage(): React.ReactElement {
  // useSearchParams (the ?view= of the Output | Diagram tabs) needs a Suspense boundary.
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted-foreground">
          Loading run details…
        </p>
      }
    >
      <RunDetailContent />
    </Suspense>
  );
}

function RunDetailContent(): React.ReactElement {
  const params = useParams<{ jobId: string; runId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Local state switches tabs instantly; ?view=diagram mirrors it so the view is linkable.
  const [view, setView] = useState<RunView>(() =>
    parseRunView(searchParams.get("view")),
  );
  // A run whose work happened in an inner Claude session opens on that session, unless a
  // ?view= or a click already chose a tab.
  const viewChosen = useRef(searchParams.get("view") !== null);
  // The diagram mounts on first open, then stays mounted so its expanded state survives tab switches.
  const [diagramOpened, setDiagramOpened] = useState(view === "diagram");
  const [run, setRun] = useState<RunResponse | null>(null);
  const [siblingRuns, setSiblingRuns] = useState<RunResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  // ?host= names the Mac that ran it; another Mac's run is read from its mirrored data.
  const runHost = searchParams.get("host") ?? undefined;
  const { isSelfHost, roleOf, colorOf, multi } = useHostView();
  const fromOtherHost = Boolean(runHost && multi && !isSelfHost(runHost));

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | null = null;
    setRun(null);
    setSiblingRuns([]);
    setError(null);
    setIsLoading(true);
    const poll = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      getRuns({ job: params.jobId, host: runHost, scope: "all" })
        .then((runs) => {
          if (!disposed) setSiblingRuns(runs);
        })
        .catch(() => {});
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const exactRun = await getRun(
          params.jobId,
          params.runId,
          controller.signal,
          runHost,
        );
        if (!disposed) {
          setRun(exactRun);
          setError(null);
        }
      } catch (failure) {
        if (!disposed) {
          if (failure instanceof ApiError && failure.status === 404) {
            setRun(null);
            setError(
              "Run not found. It may have been pruned from retained history.",
            );
          } else {
            setError(
              failure instanceof Error
                ? failure.message
                : "Unable to load this run",
            );
          }
        }
      } finally {
        clearTimeout(timeout);
        pending = false;
        if (!disposed) setIsLoading(false);
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 5_000);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
    };
  }, [params.jobId, params.runId, retry, runHost]);

  const statusColors: Record<string, string> = {
    running: "border-yellow-500/50 text-yellow-500",
    success: "border-green-500/50 text-green-500",
    partial: "border-amber-500/50 text-amber-500",
    failed: "border-red-500/50 text-red-500",
    timeout: "border-orange-500/50 text-orange-500",
  };

  const evalStyles: Record<
    string,
    { border: string; bg: string; text: string; icon: string }
  > = {
    ok: {
      border: "border-green-500/30",
      bg: "bg-green-500/5",
      text: "text-green-500",
      icon: "\u2713",
    },
    info: {
      border: "border-blue-500/30",
      bg: "bg-blue-500/5",
      text: "text-blue-500",
      icon: "\u2139",
    },
    warning: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/5",
      text: "text-amber-500",
      icon: "\u26A0",
    },
    critical: {
      border: "border-red-500/30",
      bg: "bg-red-500/5",
      text: "text-red-500",
      icon: "!!",
    },
  };

  const evalData = run?.evaluation;
  const es = evalData
    ? (evalStyles[evalData.severity] ?? evalStyles.info)
    : null;

  // Prev/next navigation
  const currentIndex = siblingRuns.findIndex((r) => r.runId === params.runId);
  const prevRun =
    currentIndex >= 0 && currentIndex < siblingRuns.length - 1
      ? siblingRuns[currentIndex + 1]
      : null;
  const nextRun = currentIndex > 0 ? siblingRuns[currentIndex - 1] : null;
  const viewQuery = view === "output" ? "" : `?view=${view}`;
  const innerSessions = run?.innerSessions ?? 0;

  useEffect(() => {
    if (innerSessions > 0 && !viewChosen.current) {
      viewChosen.current = true;
      setView("session");
    }
  }, [innerSessions]);

  const changeView = (next: RunView): void => {
    viewChosen.current = true;
    setView(next);
    if (next === "diagram") setDiagramOpened(true);
    const query = new URLSearchParams(searchParams.toString());
    if (next !== "output") query.set("view", next);
    else query.delete("view");
    const qs = query.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  return (
    <div className="flex flex-col h-full">
      {fromOtherHost && runHost && (
        <p
          role="status"
          className="mb-3 rounded px-3 py-1.5 text-[12px]"
          style={{
            borderLeft: `6px solid ${colorOf(runHost)}`,
            backgroundColor: `color-mix(in oklch, ${colorOf(runHost)} 14%, var(--color-card))`,
          }}
        >
          <span className="font-semibold">Run from {roleOf(runHost)}</span>
          <span className="text-muted-foreground"> · read-only, copied from that Mac every 5 minutes</span>
        </p>
      )}
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          {"\u2190"} Back
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold truncate">
            {run?.jobName ?? params.jobId}
          </h1>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {params.runId}
          </p>
        </div>
        {run && (
          <Badge variant="outline" className={statusColors[run.status] ?? ""}>
            {run.status === "running" && (
              <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-500" />
            )}
            {run.status}
          </Badge>
        )}
        {run?.trigger === "catchup" && <CatchupBadge run={run} />}
        <div className="flex items-center gap-1 ml-auto">
          {run?.finishedAt && (
            <span className="text-xs text-muted-foreground mr-3">
              Exit code: {run.exitCode}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!prevRun}
            onClick={() =>
              prevRun &&
              router.push(runHref({ ...prevRun, host: prevRun.host ?? runHost }, viewQuery))
            }
          >
            {"\u2190"} Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!nextRun}
            onClick={() =>
              nextRun &&
              router.push(runHref({ ...nextRun, host: nextRun.host ?? runHost }, viewQuery))
            }
          >
            Next {"\u2192"}
          </Button>
        </div>
      </div>

      {isLoading && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          Loading run details…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-card p-3 text-sm"
        >
          <p>
            {run ? "Refresh failed; displaying the last report. " : ""}
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry run
          </Button>
        </div>
      )}

      {/* AI Evaluation Card */}
      {evalData && es && (
        <Card className={`mb-4 ${es.border} ${es.bg}`}>
          <CardContent className="py-3">
            <div className="flex items-start gap-3">
              <span className={`text-lg ${es.text}`}>{es.icon}</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-sm font-medium ${es.text}`}>
                    AI Evaluation —{" "}
                    {evalData.severity.charAt(0).toUpperCase() +
                      evalData.severity.slice(1)}
                  </span>
                  {evalData.source && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground"
                    >
                      {evalData.source === "haiku"
                        ? "Haiku"
                        : evalData.source === "jev"
                          ? "Jev"
                          : "Jev · Haiku summary"}
                    </Badge>
                  )}
                  {evalData.followUpNeeded && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-amber-500/30 text-amber-500"
                    >
                      follow-up needed
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {evalData.summary}
                </p>
                {evalData.followUpReason && (
                  <p className="text-sm mt-2">
                    <span className="text-muted-foreground font-medium">
                      Follow-up reason:{" "}
                    </span>
                    <span className="text-foreground/80">
                      {evalData.followUpReason}
                    </span>
                  </p>
                )}
                {run?.decision && (
                  <p className="mt-2 font-mono text-xs text-muted-foreground tabular-nums">
                    Jev{evalData.source === "haiku" ? " (shadow)" : ""}:{" "}
                    {run.decision.severity.label} p=
                    {run.decision.severity.probabilities[
                      run.decision.severity.label
                    ].toFixed(2)}
                    {" · "}follow-up p=
                    {run.decision.followUp.probability.toFixed(2)}
                    {" · "}
                    {run.decision.failureKind.choice} p=
                    {(
                      run.decision.failureKind.probabilities[
                        run.decision.failureKind.choice
                      ] ?? 0
                    ).toFixed(2)}
                    {" · "}
                    {run.decision.latencyMs} ms · {run.decision.model}
                  </p>
                )}
                {evalData.evaluatedAt && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Evaluated {new Date(evalData.evaluatedAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {run && (
        <RunCostDetails cost={run.cost} configuredModel={run.configuredModel} />
      )}
      {run && (
        <Tabs
          value={view}
          onValueChange={(value) =>
            changeView(parseRunView(typeof value === "string" ? value : null))
          }
          className="min-h-0 flex-1"
        >
          <TabsList variant="line" aria-label="Run view">
            <TabsTrigger value="output">Output</TabsTrigger>
            {innerSessions > 0 && (
              <TabsTrigger value="session">
                Claude session{innerSessions > 1 ? `s (${innerSessions})` : ""}
              </TabsTrigger>
            )}
            <TabsTrigger value="diagram">Diagram</TabsTrigger>
          </TabsList>
          {/* keepMounted: the log is fetched incrementally, so hiding it must not discard what was read. */}
          <TabsContent value="output" keepMounted className="min-h-0">
            <LogViewer
              jobId={params.jobId}
              runId={params.runId}
              host={runHost}
              active={view === "output"}
            />
          </TabsContent>
          {/* A script run's own output is a few status lines; the work is in the Claude session it
              started (autopilot's b2c-toolkit runs), copied into the run by the daemon. */}
          {innerSessions > 0 && (
            <TabsContent value="session" keepMounted className="min-h-0">
              <LogViewer
                jobId={params.jobId}
                runId={params.runId}
                host={runHost}
                file="session"
                active={view === "session"}
              />
            </TabsContent>
          )}
          <TabsContent
            value="diagram"
            keepMounted={diagramOpened}
            className="min-w-0"
          >
            <RunDiagram
              jobId={params.jobId}
              runId={params.runId}
              host={runHost}
              run={run}
              active={view === "diagram"}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
