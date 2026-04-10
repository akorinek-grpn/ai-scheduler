import { NextResponse } from "next/server";
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

export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<NextResponse> {
  const { jobId } = await params;
  const url = getDaemonUrl();
  if (!url) return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  try {
    const body = await request.json();
    const res = await fetch(`${url}/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Daemon not available" }, { status: 503 });
  }
}
