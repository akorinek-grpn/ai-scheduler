"use client";

import React, { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { RunGraph } from "../../shared/run-graph-types";
import { ApiError, getRunGraph, type RunResponse } from "../lib/api-client";
import { isRunGraph } from "../lib/run-diagram";
import { Button } from "./ui/button";
import { RunDiagramView } from "./run-diagram/view";

export { RunDiagramView } from "./run-diagram/view";

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface GraphState {
  /** `${jobId}/${runId}` this state was loaded for; state for another run reads as a fresh load. */
  key: string;
  graph: RunGraph | null;
  error: string | null;
  notFound: boolean;
}

interface RunDiagramProps {
  jobId: string;
  runId: string;
  run: RunResponse;
  /** False while the Diagram tab is hidden: polling pauses, and resumes with an immediate refresh. */
  active?: boolean;
}

/**
 * Loads a run's graph and renders it. While the run is running and the diagram
 * is active it polls every 3s (one request at a time); a failed refresh keeps
 * the last good diagram.
 */
export function RunDiagram({
  jobId,
  runId,
  run,
  active = true,
}: RunDiagramProps): React.ReactElement {
  const key = `${jobId}/${runId}`;
  const [stored, setStored] = useState<GraphState>({
    key,
    graph: null,
    error: null,
    notFound: false,
  });
  const [reload, setReload] = useState(0);
  // The run key whose graph is final (finished run, or no graph data), so
  // re-activating the tab does not refetch a diagram that cannot change.
  const settledKey = useRef<string | null>(null);
  const runIsLive = run.status === "running";
  const state: GraphState =
    stored.key === key
      ? stored
      : { key, graph: null, error: null, notFound: false };

  useEffect(() => {
    if (!active || settledKey.current === key) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let live = runIsLive;

    const load = async (): Promise<void> => {
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const graph: unknown = await getRunGraph(jobId, runId, request.signal);
        if (disposed) return;
        if (!isRunGraph(graph))
          throw new Error(
            "The daemon returned diagram data this page cannot read.",
          );
        live = graph.status === "running";
        settledKey.current = live ? null : key;
        setStored({ key, graph, error: null, notFound: false });
      } catch (failure) {
        if (disposed) return;
        if (failure instanceof ApiError && failure.status === 404) {
          live = false;
          settledKey.current = key;
          setStored({ key, graph: null, error: null, notFound: true });
        } else {
          const message = request.signal.aborted
            ? "The diagram request timed out."
            : failure instanceof Error
              ? failure.message
              : "Unable to load the diagram.";
          setStored((previous) => ({
            key,
            graph: previous.key === key ? previous.graph : null,
            error: message,
            notFound: false,
          }));
        }
      } finally {
        clearTimeout(timeout);
      }
      // Schedule the next poll only after this one settles, so requests never overlap.
      if (!disposed && live)
        timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
    };

    void load();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, runId, key, runIsLive, reload, active]);

  const retry = (): void => {
    settledKey.current = null;
    setStored((previous) =>
      previous.key === key ? { ...previous, error: null } : previous,
    );
    setReload((value) => value + 1);
  };

  if (state.notFound) {
    return (
      <p className="py-6 text-center text-[13px] text-muted-foreground">
        No diagram data for this run.
      </p>
    );
  }
  if (!state.graph) {
    if (state.error) {
      return (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-card p-3 text-sm"
        >
          <p className="min-w-0 break-words">{state.error}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry diagram
          </Button>
        </div>
      );
    }
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading diagram…
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {state.error && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 text-[12px] text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{`Refresh failed; showing the last diagram. ${state.error}`}</span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-[24px] items-center rounded px-1 font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Retry
          </button>
        </p>
      )}
      <RunDiagramView
        graph={state.graph}
        trigger={run.trigger}
        directory={run.directory}
      />
    </div>
  );
}
