import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCostStats, getRun } from "../api-client";

afterEach(() => vi.unstubAllGlobals());

describe("cost API reads", () => {
  it.each([7, 30, 90] as const)("requests a %i-day period without caching", async (days) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ days })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCostStats(days)).toEqual({ days });
    expect(fetchMock).toHaveBeenCalledWith(`/api/stats/costs?days=${days}`, expect.objectContaining({ cache: "no-store" }));
  });

  it("loads an exact older run rather than searching a truncated list", async () => {
    const oldRun = { jobId: "job name", runId: "older-run", cost: { totalCostUsd: null } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(oldRun)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getRun("job name", "older-run")).toEqual(oldRun);
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/job%20name/older-run", expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves 404 errors for the not-found state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Run not found" }), { status: 404 })));
    const error = await getRun("job", "pruned-run").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: "Run not found" });
  });

  it("passes abort signals for cancelled period requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await getCostStats(7, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith("/api/stats/costs?days=7", expect.objectContaining({ signal: controller.signal }));
  });
});
