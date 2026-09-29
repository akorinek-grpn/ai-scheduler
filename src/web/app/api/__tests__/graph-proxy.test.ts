import fs from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getRunGraph } from "../runs/[jobId]/[runId]/graph/route";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockDaemon(): void {
  vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ port: 3501 }));
}

function request(jobId: string, runId: string) {
  return getRunGraph(
    new NextRequest(`http://localhost/api/runs/${jobId}/${runId}/graph`),
    { params: Promise.resolve({ jobId, runId }) },
  );
}

describe("run graph proxy", () => {
  it("forwards encoded identifiers uncached and passes the graph through without caching it", async () => {
    mockDaemon();
    const graph = { jobId: "job space", runId: "run/1", kind: "agent" };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(graph)));
    vi.stubGlobal("fetch", fetchMock);
    const response = await request("job space", "run/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3501/api/runs/job%20space/run%2F1/graph",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(graph);
    // Live runs change every poll, so no layer may cache the graph.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    [404, { error: "Run not found" }],
    [500, { error: "Failed to build run graph" }],
  ])("preserves a daemon %i and its error body", async (status, body) => {
    // The Diagram tab shows "No diagram data" only for a real 404.
    mockDaemon();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
    );
    const response = await request("job", "pruned");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("answers 502 with a restart hint when a daemon that predates run graphs returns Express's HTML 404", async () => {
    mockDaemon();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            "<!DOCTYPE html><html><body><pre>Cannot GET /api/runs/job/run/graph</pre></body></html>",
            { status: 404, headers: { "content-type": "text/html" } },
          ),
        ),
    );
    const response = await request("job", "run");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("(404)");
    expect(body.error).toContain("restart the daemon");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a retryable 503 when the daemon does not answer", async () => {
    mockDaemon();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );
    const response = await request("job", "run");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Daemon not available" });
  });

  it("returns 503 without a network request when the daemon metadata is missing", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("missing");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await request("job", "run");
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
