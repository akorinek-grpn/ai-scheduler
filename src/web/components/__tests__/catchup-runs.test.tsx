import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CatchupQueueSnapshot, RunResponse } from "../../lib/api-client";
import { CatchupRunsPanel } from "../catchup-runs";
import { textContrasts } from "./contrast";

// Local-time constructors keep the slot labels independent of the machine's time zone.
const local = (
  month: number,
  day: number,
  hour: number,
  minute: number,
): string => new Date(2026, month - 1, day, hour, minute).toISOString();
const NOW = Date.parse(local(9, 29, 10, 0)); // Tuesday 10:00
const EMPTY_QUEUE: CatchupQueueSnapshot = { queued: [], inFlight: null };

function run(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    jobId: "daily-check",
    runId: "run-1",
    jobName: "Daily Check",
    directory: "/tmp",
    status: "success",
    trigger: "catchup",
    startedAt: local(9, 29, 8, 14),
    finishedAt: local(9, 29, 8, 20),
    exitCode: 0,
    catchupFor: local(9, 28, 9, 5),
    cost: {
      currency: "USD",
      totalCostUsd: null,
      executionCostUsd: null,
      evaluationCostUsd: null,
      coverage: "unavailable",
      evaluationState: "unavailable",
      attempts: [],
      evaluation: null,
      tokens: null,
    },
    ...overrides,
  };
}

function render(
  runs: RunResponse[],
  queue: CatchupQueueSnapshot | null,
): string {
  return renderToStaticMarkup(
    <CatchupRunsPanel runs={runs} queue={queue} now={NOW} />,
  );
}

const tbodyRows = (html: string): number => {
  const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
  return body.split("<tr").length - 1;
};

describe("CatchupRunsPanel (history)", () => {
  // Ten catch-ups, one per hour back from 08:00 today, plus runs that must not appear.
  const catchups = Array.from({ length: 10 }, (_, index) =>
    run({
      runId: `catchup-${index + 1}`,
      jobName: `Job ${index + 1}`,
      startedAt: new Date(
        Date.parse(local(9, 29, 8, 0)) - index * 3_600_000,
      ).toISOString(),
    }),
  );
  catchups[0] = run({
    runId: "catchup-1",
    jobId: "report",
    jobName: "Morning Report",
    status: "failed",
    exitCode: 1,
    startedAt: local(9, 29, 8, 14),
    catchupFor: local(9, 28, 9, 5),
  });
  const runs = [
    ...catchups,
    run({
      runId: "scheduled",
      jobName: "Scheduled Only",
      trigger: "scheduled",
      startedAt: local(9, 29, 9, 0),
    }),
    run({ runId: "old", jobName: "Too Old", startedAt: local(9, 20, 9, 0) }),
  ];
  const html = render(runs, EMPTY_QUEUE);

  it("titles the section with an h2 and summarizes the last 7 days", () => {
    expect(html).toMatch(/<h2[^>]*>Caught-up runs<\/h2>/);
    expect(html).toContain("10 caught up in the last 7 days");
    expect(html).not.toContain("waiting");
  });

  it("lists at most 8 catch-ups, newest first, in a table with column headers", () => {
    expect(tbodyRows(html)).toBe(8);
    for (const header of ["Status", "Job", "Missed slot", "Ran at", "Late by"])
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${header}</th>`));
    expect(html.indexOf("Morning Report")).toBeLessThan(html.indexOf("Job 2<"));
    expect(html).toContain("Job 8<");
    expect(html).not.toContain("Job 9<");
    expect(html).not.toContain("Scheduled Only");
    expect(html).not.toContain("Too Old");
  });

  it("shows each run's status in words, a link to the run, the missed slot, when it ran and how late", () => {
    expect(html).toContain("failed");
    expect(html).toContain('href="/runs/report/catchup-1"');
    expect(html).toContain("Mon 09:05");
    expect(html).toContain("Tue 08:14");
    expect(html).toContain("23h 9m");
  });

  it("links to all catch-up runs on the Runs page", () => {
    expect(html).toContain('href="/runs?trigger=catchup"');
    expect(html).toContain("View all");
  });

  it("says the late-by time is unknown when the run did not record its slot", () => {
    const unknown = render([run({ catchupFor: undefined })], EMPTY_QUEUE);
    expect(unknown).toContain('<span class="sr-only">unknown</span>');
  });

  it("keeps all text at 4.5:1 or more on the page and card surfaces in light and dark themes", () => {
    const contrasts = textContrasts(html);
    expect(contrasts.length).toBeGreaterThan(0);
    for (const entry of contrasts) {
      expect(entry.light, entry.classes).toBeGreaterThanOrEqual(4.5);
      expect(entry.dark, entry.classes).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("CatchupRunsPanel (queue)", () => {
  const queue: CatchupQueueSnapshot = {
    queued: [
      {
        jobId: "digest",
        jobName: "Weekly Digest",
        missedSlot: local(9, 28, 18, 0),
        enqueuedAt: local(9, 29, 9, 50),
      },
      {
        jobId: "audit",
        jobName: "Audit",
        missedSlot: local(9, 22, 7, 30),
        enqueuedAt: local(9, 29, 9, 50),
      },
    ],
    inFlight: {
      jobId: "daily-check",
      jobName: "Daily Check",
      startedAt: local(9, 29, 9, 55),
    },
  };
  const live = run({
    runId: "live",
    status: "running",
    finishedAt: null,
    exitCode: null,
    startedAt: local(9, 29, 9, 55),
    catchupFor: local(9, 29, 9, 0),
  });
  const html = render([live], queue);

  it("counts what is waiting and running in the summary", () => {
    expect(html).toContain(
      "1 caught up in the last 7 days · 2 waiting · 1 running",
    );
  });

  it("shows the in-flight catch-up with its missed slot, how long ago it started and a link to its run", () => {
    const now = html.slice(html.indexOf(">Now<"), html.indexOf("<table"));
    expect(now).toContain("running");
    expect(now).toContain('href="/runs/daily-check/live"');
    expect(now).toContain("missed Tue 09:00");
    expect(now).toContain("started 5m ago");
  });

  it("lists queued catch-ups with the slot each one missed", () => {
    expect(html).toContain("Weekly Digest");
    expect(html).toContain("missed Mon 18:00");
    expect(html).toContain("Audit");
    expect(html).toContain("missed Tue Sep 22 07:30");
  });

  it("keeps the in-flight job without a link when its run record is not loaded yet", () => {
    const unlinked = render([], { queued: [], inFlight: queue.inFlight });
    expect(unlinked).toContain("Daily Check");
    expect(unlinked).not.toContain('href="/runs/daily-check/');
    expect(unlinked).toContain("started 5m ago");
  });

  it("keeps all text at 4.5:1 or more on the page and card surfaces in light and dark themes", () => {
    for (const entry of textContrasts(html)) {
      expect(entry.light, entry.classes).toBeGreaterThanOrEqual(4.5);
      expect(entry.dark, entry.classes).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("CatchupRunsPanel (empty)", () => {
  it("says nothing needed catching up, without a table or a Now block", () => {
    const html = render([run({ trigger: "scheduled" })], EMPTY_QUEUE);
    expect(html).toContain("No runs needed catching up in the last 7 days.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain(">Now<");
  });

  it("shows no Now block when the queue is unreachable", () => {
    const html = render([run()], null);
    expect(html).not.toContain(">Now<");
    expect(html).toContain("1 caught up in the last 7 days");
  });

  it("treats a malformed queue snapshot as empty instead of failing", () => {
    const malformed = {
      queued: undefined,
      inFlight: undefined,
    } as unknown as CatchupQueueSnapshot;
    const html = render([run()], malformed);
    expect(html).not.toContain(">Now<");
    expect(html).not.toContain("waiting");
    expect(html).not.toContain("running");
  });
});
