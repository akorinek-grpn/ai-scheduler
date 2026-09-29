"use client";

import { useEffect, useRef, useState } from "react";
import { getRunLog, type LogResponse } from "@/lib/api-client";

interface LogViewerProps {
  jobId: string;
  runId: string;
  /** False while the log's tab is hidden; once shown again it re-scrolls to the end if auto-scroll is on. */
  active?: boolean;
}

export function LogViewer({ jobId, runId, active = true }: LogViewerProps): React.ReactElement {
  const [lines, setLines] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [isDone, setIsDone] = useState(false);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const data: LogResponse = await getRunLog(jobId, runId, offset);
        if (!active) return;

        if (data.content) {
          setLines((prev) => prev + data.content);
          setOffset(data.offset);
        }
        if (data.done) {
          setIsDone(true);
        }
      } catch {
        // retry on next interval
      }
    };

    poll();
    const interval = isDone ? null : setInterval(poll, 3_000);

    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [jobId, runId, offset, isDone]);

  // A hidden log cannot scroll, so the scroll to the end runs again when it is shown.
  useEffect(() => {
    if (active && isAutoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, isAutoScroll, active]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setIsAutoScroll(isAtBottom);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {!isDone && (
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
          )}
          <span className="text-xs text-muted-foreground">
            {isDone ? "Run completed" : "Live output — polling every 3s"}
          </span>
        </div>
        {!isDone && (
          <button
            onClick={() => setIsAutoScroll(!isAutoScroll)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {isAutoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto rounded-md border border-border bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300"
        style={{ minHeight: 400, maxHeight: "calc(100vh - 280px)" }}
      >
        <pre className="whitespace-pre-wrap">{lines || "Waiting for output..."}</pre>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
