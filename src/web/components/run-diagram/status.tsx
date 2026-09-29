import React from "react";
import { Check, CircleX } from "lucide-react";
import type { OutcomeTone, StatusDisplay } from "../../lib/run-diagram";

/**
 * Text colors for outcomes. The 700/400 shades keep >= 4.5:1 contrast on the
 * card surface in light and dark themes; the word itself always carries the status.
 */
export const TONE_TEXT: Record<OutcomeTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  error: "text-red-700 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-400",
  live: "text-foreground",
  muted: "text-muted-foreground",
};

/** Rail marker fill per outcome; paired with outcome text, never used alone. */
export const TONE_MARKER: Record<OutcomeTone, string> = {
  ok: "bg-green-600 dark:bg-green-500",
  error: "bg-red-600 dark:bg-red-500",
  warning: "bg-amber-600 dark:bg-amber-500",
  live: "bg-yellow-500 animate-pulse",
  muted: "bg-muted-foreground",
};

/**
 * Success stays recessive; errors and missing results are spelled out. `count`
 * (a group row where only some calls are pending) is spelled out next to the
 * live dot or the "no result" text.
 */
export function StatusMark({
  status,
  count = null,
}: {
  status: StatusDisplay;
  count?: number | null;
}): React.ReactElement | null {
  switch (status) {
    case "ok":
      return (
        <span className="inline-flex shrink-0 items-center" title="ok">
          <Check
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
          <span className="sr-only">ok</span>
        </span>
      );
    case "error":
      return (
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium ${TONE_TEXT.error}`}
        >
          <CircleX aria-hidden="true" className="size-3.5" />
          error
        </span>
      );
    case "live":
      // The steady dot carries the state, so it never fades: yellow-700 is 4.8:1
      // on the light card and yellow-500 10:1 on the dark one (WCAG 1.4.11 asks
      // for 3:1). Only the halo behind it animates.
      return (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
          title="In progress"
        >
          <span
            aria-hidden="true"
            className="relative inline-flex size-3.5 items-center justify-center"
          >
            <span className="absolute size-1.5 rounded-full bg-yellow-700 opacity-75 motion-safe:animate-ping dark:bg-yellow-500" />
            <span className="relative size-1.5 rounded-full bg-yellow-700 dark:bg-yellow-500" />
          </span>
          {count === null ? (
            <span className="sr-only">in progress</span>
          ) : (
            `${count} in progress`
          )}
        </span>
      );
    case "no-result":
      return (
        <span className={`shrink-0 text-[11px] ${TONE_TEXT.warning}`}>
          {count === null ? "no result" : `${count} no result`}
        </span>
      );
    case "stopped":
      return (
        <span className={`shrink-0 text-[11px] ${TONE_TEXT.warning}`}>
          stopped
        </span>
      );
    default:
      return null;
  }
}
