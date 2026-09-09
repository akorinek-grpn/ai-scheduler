import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(process.cwd());
const RESEARCH_DIR = path.join(PROJECT_ROOT, "data", "research");

export interface ResearchFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category?: string;
  jobId?: string;
  title: string;
  currentBehavior?: string;
  proposal?: string;
  expectedImpact?: string;
}

export interface ResearchReport {
  date: string;
  markdown: string | null;
  findings: ResearchFinding[] | null;
  totals: Record<string, number> | null;
  summary: string | null;
  generatedAt: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> },
): Promise<NextResponse> {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const mdPath = path.join(RESEARCH_DIR, `${date}-analysis.md`);
  const jsonPath = path.join(RESEARCH_DIR, `${date}-findings.json`);

  const markdown = fs.existsSync(mdPath)
    ? fs.readFileSync(mdPath, "utf-8")
    : null;
  let findings: ResearchFinding[] | null = null;
  let totals: Record<string, number> | null = null;
  let summary: string | null = null;
  let generatedAt: string | null = null;

  if (fs.existsSync(jsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      findings = json.findings ?? null;
      totals = json.totals ?? null;
      summary = json.summary ?? null;
      generatedAt = json.generatedAt ?? null;
    } catch {
      // tolerate malformed json
    }
  }

  if (!markdown && !findings) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  const report: ResearchReport = {
    date,
    markdown,
    findings,
    totals,
    summary,
    generatedAt,
  };
  return NextResponse.json(report);
}
