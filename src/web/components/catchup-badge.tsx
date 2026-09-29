import React from "react";
import type { RunResponse } from "../lib/api-client";
import { describeCatchup } from "../lib/catchup-runs";

interface CatchupBadgeProps {
  run: Pick<RunResponse, "catchupFor" | "startedAt">;
  /** Reference time for the slot label; defaults to now. */
  now?: number;
}

/**
 * Marks a run that caught up a missed scheduled slot. The words carry the meaning;
 * blue-700 / blue-400 keep them at >= 4.5:1 on the page and card in both themes.
 */
export function CatchupBadge({
  run,
  now,
}: CatchupBadgeProps): React.ReactElement {
  const description = describeCatchup(run, now);
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-blue-700/40 px-1.5 text-[11px] font-medium leading-none text-blue-700 dark:border-blue-400/40 dark:text-blue-400"
      title={description}
    >
      <span aria-hidden="true">↻</span>
      caught up
      <span className="sr-only">: {description}</span>
    </span>
  );
}
