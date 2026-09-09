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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const days = request.nextUrl.searchParams.get("days") ?? "30";
  if (!["7", "30", "90"].includes(days)) {
    return NextResponse.json({ error: "days must be 7, 30 or 90" }, { status: 400 });
  }
  const url = getDaemonUrl();
  if (!url) return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  try {
    const response = await fetch(`${url}/api/stats/costs?days=${days}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
