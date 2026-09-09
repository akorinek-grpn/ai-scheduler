import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(process.cwd());
const RESEARCH_DIR = path.join(PROJECT_ROOT, "data", "research");

export interface ResearchIndexEntry {
  date: string;
  hasFindings: boolean;
  totals?: Record<string, number>;
  summary?: string;
}

export async function GET(): Promise<NextResponse> {
  if (!fs.existsSync(RESEARCH_DIR)) {
    return NextResponse.json({ reports: [] });
  }

  const files = fs.readdirSync(RESEARCH_DIR);
  const byDate = new Map<string, ResearchIndexEntry>();

  for (const file of files) {
    const analysisMatch = file.match(/^(\d{4}-\d{2}-\d{2})-analysis\.md$/);
    const findingsMatch = file.match(/^(\d{4}-\d{2}-\d{2})-findings\.json$/);
    const date = analysisMatch?.[1] ?? findingsMatch?.[1];
    if (!date) continue;
    const entry = byDate.get(date) ?? { date, hasFindings: false };
    if (findingsMatch) {
      try {
        const json = JSON.parse(
          fs.readFileSync(path.join(RESEARCH_DIR, file), "utf-8"),
        );
        entry.hasFindings = true;
        entry.totals = json.totals;
        entry.summary = json.summary;
      } catch {
        // tolerate malformed json
      }
    }
    byDate.set(date, entry);
  }

  const reports = [...byDate.values()].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  return NextResponse.json({ reports });
}
