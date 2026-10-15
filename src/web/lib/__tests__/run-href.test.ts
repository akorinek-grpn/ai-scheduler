import { describe, it, expect } from "vitest";
import { runHref } from "../api-client";

describe("runHref", () => {
  it("links a run without a host as before", () => {
    expect(runHref({ jobId: "daily-ops", runId: "2026-10-15T09-05-00-ab" })).toBe(
      "/runs/daily-ops/2026-10-15T09-05-00-ab",
    );
  });

  it("carries the host that ran it, so the page reads that Mac's data", () => {
    expect(runHref({ jobId: "babysit-prs", runId: "r-1", host: "FL2R12XFMX" })).toBe(
      "/runs/babysit-prs/r-1?host=FL2R12XFMX",
    );
  });

  it("keeps other query parameters such as the diagram view", () => {
    expect(runHref({ jobId: "j", runId: "r", host: "AIR" }, "?view=diagram")).toBe(
      "/runs/j/r?view=diagram&host=AIR",
    );
    expect(runHref({ jobId: "j", runId: "r" }, "?view=diagram")).toBe("/runs/j/r?view=diagram");
  });

  it("encodes path segments", () => {
    expect(runHref({ jobId: "a b", runId: "c/d" })).toBe("/runs/a%20b/c%2Fd");
  });
});
