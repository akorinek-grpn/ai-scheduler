import fs from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getCostStats } from "../stats/costs/route";
import { GET as getExactRun } from "../runs/[jobId]/[runId]/route";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockDaemon(): void {
  vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ port: 3501 }));
}

describe("cost stats proxy", () => {
  it.each([7, 30, 90])("forwards the %i-day range and preserves unknown costs", async (days) => {
    mockDaemon();
    const data = { days, period: { totalCostUsd: null, trackedRuns: 0 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal("fetch", fetchMock);
    const response = await getCostStats(new NextRequest(`http://localhost/api/stats/costs?days=${days}`));
    expect(await response.json()).toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:3501/api/stats/costs?days=${days}`, expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it("defaults to 30 days", async () => {
    mockDaemon();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await getCostStats(new NextRequest("http://localhost/api/stats/costs"));
    expect(fetchMock.mock.calls[0][0]).toContain("days=30");
  });

  it("rejects invalid ranges without reaching the daemon", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await getCostStats(new NextRequest("http://localhost/api/stats/costs?days=8"));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a retryable failure, not zero costs, when the daemon is unavailable", async () => {
    mockDaemon();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const response = await getCostStats(new NextRequest("http://localhost/api/stats/costs"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Daemon not available" });
  });

  it("handles missing daemon metadata without a network request", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("missing"); });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await getCostStats(new NextRequest("http://localhost/api/stats/costs"));
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("exact run proxy", () => {
  it("forwards exact encoded identifiers and preserves the run cost response", async () => {
    mockDaemon();
    const data = { runId: "old run", cost: { totalCostUsd: null } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal("fetch", fetchMock);
    const response = await getExactRun(new NextRequest("http://localhost/api/runs/job/old"), { params: Promise.resolve({ jobId: "job space", runId: "old run" }) });
    expect(await response.json()).toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3501/api/runs/job%20space/old%20run", expect.objectContaining({ cache: "no-store" }));
  });

  it("preserves a daemon 404 instead of returning an empty successful record", async () => {
    mockDaemon();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Run not found" }), { status: 404 })));
    const response = await getExactRun(new NextRequest("http://localhost/api/runs/job/pruned"), { params: Promise.resolve({ jobId: "job", runId: "pruned" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Run not found" });
  });
});
