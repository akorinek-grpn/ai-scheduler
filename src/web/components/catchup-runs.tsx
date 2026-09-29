import React, { useId } from "react";
import Link from "next/link";
import type {
  CatchupQueueEntry,
  CatchupQueueInFlight,
  CatchupQueueSnapshot,
  RunResponse,
} from "../lib/api-client";
import {
  CATCHUP_RUNS_HREF,
  CATCHUP_WINDOW_DAYS,
  catchupDelayMs,
  formatDelay,
  formatSlot,
  inFlightCatchupRun,
  recentCatchupRuns,
} from "../lib/catchup-runs";

const MAX_ROWS = 8;
const MAX_QUEUED_SHOWN = 5;

/**
 * Status word colours hold >= 4.5:1 on the page and card in both themes; the dot is
 * decoration next to the word. Success stays recessive.
 */
const STATUS_STYLE: Record<
  RunResponse["status"],
  { dot: string; text: string }
> = {
  success: {
    dot: "bg-green-600 dark:bg-green-500",
    text: "text-muted-foreground",
  },
  running: { dot: "bg-yellow-700 dark:bg-yellow-500", text: "text-foreground" },
  partial: {
    dot: "bg-amber-600 dark:bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
  },
  failed: {
    dot: "bg-red-600 dark:bg-red-500",
    text: "text-red-700 dark:text-red-400",
  },
  timeout: {
    dot: "bg-orange-600 dark:bg-orange-500",
    text: "text-orange-700 dark:text-orange-400",
  },
};

// Padding and alignment are set per cell so no two utilities compete for the same property.
const HEADER_CELL =
  "py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground";
const TIME_CELL =
  "whitespace-nowrap font-mono text-[12px] tabular-nums text-muted-foreground";

function Unknown(): React.ReactElement {
  return (
    <>
      <span aria-hidden="true">{"—"}</span>
      <span className="sr-only">unknown</span>
    </>
  );
}

function NowBlock({
  queued,
  inFlight,
  runs,
  now,
}: {
  queued: CatchupQueueEntry[];
  inFlight: CatchupQueueInFlight | null;
  runs: RunResponse[];
  now: number;
}): React.ReactElement {
  const liveRun = inFlightCatchupRun(runs, inFlight);
  const inFlightStarted = inFlight ? Date.parse(inFlight.startedAt) : NaN;
  const shownQueue = queued.slice(0, MAX_QUEUED_SHOWN);
  const hiddenQueued = queued.length - shownQueue.length;
  return (
    <div className="mb-2 rounded border border-border bg-card px-3 py-2">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Now
      </h3>
      <ul className="mt-1 space-y-0.5 text-[12px]">
        {inFlight && (
          <li className="flex flex-wrap items-center gap-x-2">
            <span className="inline-flex w-16 shrink-0 items-center gap-1.5 text-foreground">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-yellow-700 dark:bg-yellow-500"
              />
              running
            </span>
            {liveRun ? (
              <Link
                href={`/runs/${liveRun.jobId}/${liveRun.runId}`}
                className="inline-flex min-h-[24px] items-center text-[13px] hover:underline"
              >
                {inFlight.jobName}
              </Link>
            ) : (
              <span className="text-[13px] leading-[24px]">{inFlight.jobName}</span>
            )}
            {liveRun?.catchupFor && (
              <span className="text-muted-foreground">{`missed ${formatSlot(liveRun.catchupFor, now)}`}</span>
            )}
            {Number.isFinite(inFlightStarted) && (
              <span className="text-muted-foreground">
                {`started ${formatDelay(now - inFlightStarted)} ago`}
              </span>
            )}
          </li>
        )}
        {shownQueue.map((entry) => (
          <li
            key={`${entry.jobId}-${entry.missedSlot}`}
            className="flex flex-wrap items-center gap-x-2"
          >
            <span className="inline-flex w-16 shrink-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full border border-muted-foreground"
              />
              waiting
            </span>
            <span className="text-[13px] leading-[24px]">{entry.jobName}</span>
            <span className="text-muted-foreground">{`missed ${formatSlot(entry.missedSlot, now)}`}</span>
          </li>
        ))}
        {hiddenQueued > 0 && (
          <li className="text-muted-foreground">{`and ${hiddenQueued} more waiting`}</li>
        )}
      </ul>
    </div>
  );
}

interface CatchupRunsPanelProps {
  /** Candidate runs of any trigger (possibly from several fetches); catch-ups are selected here. */
  runs: RunResponse[];
  /** The live catch-up queue, or null when it could not be read. */
  queue: CatchupQueueSnapshot | null;
  now?: number;
}

/** Dashboard section for catch-up runs: what is waiting now and what caught up in the last 7 days. */
export function CatchupRunsPanel({
  runs,
  queue,
  now = Date.now(),
}: CatchupRunsPanelProps): React.ReactElement {
  const headingId = useId();
  const recent = recentCatchupRuns(runs, now);
  const shown = recent.slice(0, MAX_ROWS);
  // null (unreachable) and malformed snapshots both read as an empty queue.
  const queued = queue && Array.isArray(queue.queued) ? queue.queued : [];
  const inFlight = queue?.inFlight ?? null;
  const hasQueue = queued.length > 0 || inFlight !== null;
  const summary = [
    `${recent.length} caught up in the last ${CATCHUP_WINDOW_DAYS} days`,
    ...(queued.length > 0 ? [`${queued.length} waiting`] : []),
    ...(inFlight ? ["1 running"] : []),
  ].join(" · ");

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2">
        <h2
          id={headingId}
          className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Caught-up runs
        </h2>
        {(recent.length > 0 || hasQueue) && (
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {summary}
          </p>
        )}
        <div className="ml-2 hidden flex-1 border-t border-border/30 sm:block" />
        <Link
          href={CATCHUP_RUNS_HREF}
          className="ml-auto inline-flex min-h-[24px] items-center rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          View all<span className="sr-only"> catch-up runs</span>
        </Link>
      </div>

      {hasQueue && <NowBlock queued={queued} inFlight={inFlight} runs={runs} now={now} />}

      {shown.length > 0 ? (
        // pb-1 keeps the last row's focus outline inside the scroll container's clip.
        <div className="overflow-x-auto pb-1">
          <table className="w-full border-collapse">
            <caption className="sr-only">
              {`Catch-up runs started in the last ${CATCHUP_WINDOW_DAYS} days, newest first`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={`${HEADER_CELL} pl-3 pr-1.5 text-left`}>
                  Status
                </th>
                <th scope="col" className={`${HEADER_CELL} px-1.5 text-left`}>
                  Job
                </th>
                <th scope="col" className={`${HEADER_CELL} px-1.5 text-left`}>
                  Missed slot
                </th>
                <th
                  scope="col"
                  className={`${HEADER_CELL} hidden px-1.5 text-left sm:table-cell`}
                >
                  Ran at
                </th>
                <th scope="col" className={`${HEADER_CELL} pl-1.5 pr-3 text-right`}>
                  Late by
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((run) => {
                const style = STATUS_STYLE[run.status] ?? STATUS_STYLE.running;
                const delay = catchupDelayMs(run);
                return (
                  <tr key={`${run.jobId}-${run.runId}`}>
                    <td className="whitespace-nowrap py-0.5 pl-3 pr-1.5 text-[12px]">
                      <span
                        className={`inline-flex items-center gap-1.5 ${style.text}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                        />
                        {run.status}
                      </span>
                    </td>
                    <td className="w-full max-w-0 px-1.5 py-0.5">
                      <Link
                        href={`/runs/${run.jobId}/${run.runId}`}
                        className="block truncate text-[13px] leading-[24px] hover:underline"
                        title={run.jobName}
                      >
                        {run.jobName}
                      </Link>
                    </td>
                    <td className={`${TIME_CELL} px-1.5`}>
                      {run.catchupFor ? (
                        <time dateTime={run.catchupFor}>
                          {formatSlot(run.catchupFor, now)}
                        </time>
                      ) : (
                        <Unknown />
                      )}
                    </td>
                    <td className={`${TIME_CELL} hidden px-1.5 sm:table-cell`}>
                      <time dateTime={run.startedAt}>
                        {formatSlot(run.startedAt, now)}
                      </time>
                    </td>
                    <td className={`${TIME_CELL} pl-1.5 pr-3 text-right`}>
                      {delay === null ? <Unknown /> : formatDelay(delay)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        !hasQueue && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            No runs needed catching up in the last {CATCHUP_WINDOW_DAYS} days.
          </p>
        )
      )}
    </section>
  );
}
