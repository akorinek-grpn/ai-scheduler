import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

const PROJECT_ROOT = path.resolve(process.cwd());

function getDaemonUrl(): string | null {
  try {
    const daemonJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "data", "daemon.json"), "utf-8"),
    );
    return `http://127.0.0.1:${daemonJson.port}`;
  } catch {
    return null;
  }
}

/** Proxies the daemon's run graph (the Diagram view's data); never cached, since live runs change every poll. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string; runId: string }> },
): Promise<NextResponse> {
  const { jobId, runId } = await params;
  const url = getDaemonUrl();
  if (!url)
    return NextResponse.json(
      { error: "Daemon not available" },
      { status: 503 },
    );
  let response: Response;
  try {
    response = await fetch(
      `${url}/api/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}/graph`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return NextResponse.json(
      { error: "Daemon not available" },
      { status: 503 },
    );
  }
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers,
    });
  } catch {
    // A daemon started before the graph endpoint existed answers with Express's HTML 404.
    return NextResponse.json(
      {
        error: `Unexpected daemon response (${response.status}); restart the daemon if it predates run diagrams`,
      },
      { status: 502, headers },
    );
  }
}
