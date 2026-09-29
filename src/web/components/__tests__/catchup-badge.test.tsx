import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatchupBadge } from "../catchup-badge";
import { textContrasts } from "./contrast";

// Local-time constructors keep the slot labels independent of the machine's time zone.
const local = (
  month: number,
  day: number,
  hour: number,
  minute: number,
): string => new Date(2026, month - 1, day, hour, minute).toISOString();
const NOW = Date.parse(local(9, 29, 10, 0)); // Tuesday

describe("CatchupBadge", () => {
  const html = renderToStaticMarkup(
    <CatchupBadge
      run={{ catchupFor: local(9, 28, 9, 5), startedAt: local(9, 29, 8, 14) }}
      now={NOW}
    />,
  );

  it("shows a short visible label, with the arrow hidden from assistive technology", () => {
    expect(html).toContain('<span aria-hidden="true">↻</span>');
    expect(html).toContain("caught up");
  });

  it("says which slot it caught up and how late it started, as the tooltip and to screen readers", () => {
    const sentence =
      "Catch-up of the missed Mon 09:05 run, started 23h 9m late";
    expect(html).toContain(`title="${sentence}"`);
    expect(html).toMatch(
      new RegExp(`<span class="sr-only">[^<]*${sentence}</span>`),
    );
  });

  it("falls back to a generic description when the run did not record its slot", () => {
    const fallback = renderToStaticMarkup(
      <CatchupBadge run={{ startedAt: local(9, 29, 8, 14) }} now={NOW} />,
    );
    expect(fallback).toContain('title="Catch-up of a missed scheduled run"');
    expect(fallback).toContain("caught up");
  });

  it("keeps its text at 4.5:1 or more on the page and card surfaces in light and dark themes", () => {
    const contrasts = textContrasts(html);
    expect(contrasts.length).toBeGreaterThan(0);
    for (const entry of contrasts) {
      expect(entry.light, entry.classes).toBeGreaterThanOrEqual(4.5);
      expect(entry.dark, entry.classes).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("would catch the old blue-500 badge colour, which is below 4.5:1 on the light page", () => {
    const [old] = textContrasts(
      '<span class="text-[10px] text-blue-500">catch-up</span>',
    );
    expect(old.light).toBeLessThan(4.5);
  });
});
