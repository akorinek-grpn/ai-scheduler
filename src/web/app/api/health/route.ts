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

export async function GET(): Promise<NextResponse> {
  const url = getDaemonUrl();
  if (!url) {
    return NextResponse.json({ status: "stopped", error: "Daemon not running" }, { status: 503 });
  }
  try {
    const res = await fetch(`${url}/api/health`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "stopped", error: "Daemon not responding" }, { status: 503 });
  }
}
