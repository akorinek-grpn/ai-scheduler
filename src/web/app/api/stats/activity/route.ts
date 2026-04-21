import { NextResponse, type NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const PROJECT_ROOT = path.resolve(process.cwd());

function getDaemonUrl(): string | null {
  try {
    const daemonJsonPath = path.join(PROJECT_ROOT, "data", "daemon.json");
    const daemonJson = JSON.parse(fs.readFileSync(daemonJsonPath, "utf-8"));
    return `http://127.0.0.1:${daemonJson.port}`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = getDaemonUrl();
  if (!url) {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
  const days = req.nextUrl.searchParams.get("days") ?? "30";
  try {
    const res = await fetch(`${url}/api/stats/activity?days=${encodeURIComponent(days)}`);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
