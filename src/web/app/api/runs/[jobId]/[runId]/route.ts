import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

const PROJECT_ROOT = path.resolve(process.cwd());

function getDaemonUrl(): string | null {
  try {
    const daemonJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "data", "daemon.json"), "utf-8"));
    return `http://127.0.0.1:${daemonJson.port}`;
  } catch {
    return null;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string; runId: string }> },
): Promise<NextResponse> {
  const { jobId, runId } = await params;
  const url = getDaemonUrl();
  if (!url) return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  try {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
