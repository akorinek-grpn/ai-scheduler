"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  getResearchReport,
  type ResearchReport,
  type ResearchFinding,
} from "@/lib/api-client";

const severityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const severityStyles: Record<string, string> = {
  critical: "border-red-500/50 text-red-500",
  high: "border-amber-500/50 text-amber-500",
  medium: "border-blue-500/50 text-blue-500",
  low: "border-muted-foreground/40 text-muted-foreground",
};

export default function ResearchReportPage(): React.ReactElement {
  const params = useParams<{ date: string }>();
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getResearchReport(params.date)
      .then(setReport)
      .catch((e: Error) => setError(e.message));
  }, [params.date]);

  if (error) {
    return (
      <div className="max-w-3xl">
        <p className="text-[12px] text-red-500">
          Failed to load report: {error}
        </p>
        <Link
          href="/research"
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          &larr; back to all reports
        </Link>
      </div>
    );
  }

  if (!report)
    return <p className="text-[12px] text-muted-foreground">Loading&hellip;</p>;

  const sortedFindings = report.findings
    ? [...report.findings].sort(
        (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
      )
    : null;

  return (
    <div className="space-y-5 max-w-3xl">
      <header className="space-y-2">
        <div className="flex items-baseline gap-2">
          <Link
            href="/research"
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            &larr; all reports
          </Link>
          <span className="text-muted-foreground/50">&middot;</span>
          <h1 className="font-mono text-[13px] font-semibold">{report.date}</h1>
        </div>
        {report.summary && (
          <p className="text-[12px] text-muted-foreground">{report.summary}</p>
        )}
      </header>

      {sortedFindings && sortedFindings.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Findings ({sortedFindings.length})
          </h2>
          <div className="space-y-2">
            {sortedFindings.map((f) => (
              <FindingCard key={f.id} finding={f} />
            ))}
          </div>
        </section>
      )}

      {report.markdown && (
        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Full Report
          </h2>
          <Markdown source={report.markdown} />
        </section>
      )}
    </div>
  );
}

function FindingCard({
  finding,
}: {
  finding: ResearchFinding;
}): React.ReactElement {
  return (
    <article
      id={finding.id}
      className="rounded border border-border/40 p-3 space-y-2 scroll-mt-4"
    >
      <header className="flex items-baseline gap-2 flex-wrap">
        <Badge
          variant="outline"
          className={`text-[10px] ${severityStyles[finding.severity] ?? ""}`}
        >
          {finding.severity}
        </Badge>
        {finding.jobId && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {finding.jobId}
          </span>
        )}
        {finding.category && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {finding.category}
          </span>
        )}
        <h3 className="text-[13px] font-medium text-foreground">
          {finding.title}
        </h3>
      </header>
      {finding.currentBehavior && (
        <Field label="Current" body={finding.currentBehavior} />
      )}
      {finding.proposal && <Field label="Proposal" body={finding.proposal} />}
      {finding.expectedImpact && (
        <Field label="Impact" body={finding.expectedImpact} />
      )}
    </article>
  );
}

function Field({
  label,
  body,
}: {
  label: string;
  body: string;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2 text-[12px]">
      <span className="text-muted-foreground uppercase text-[10px] tracking-wide pt-0.5">
        {label}
      </span>
      <span className="text-foreground">{body}</span>
    </div>
  );
}

function Markdown({ source }: { source: string }): React.ReactElement {
  const blocks = parseMarkdown(source);
  return (
    <div className="space-y-2 text-[12.5px] leading-relaxed text-foreground/90">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "para"; text: string };

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join(" ") });
      continue;
    }

    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "para", text: buf.join(" ") });
  }
  return blocks;
}

function renderBlock(block: MdBlock, key: number): React.ReactElement {
  switch (block.kind) {
    case "heading": {
      const sizes: Record<number, string> = {
        1: "text-[15px] font-semibold mt-4",
        2: "text-[13.5px] font-semibold mt-3 text-foreground",
        3: "text-[12.5px] font-semibold mt-2 text-foreground",
        4: "text-[12px] font-semibold mt-2 text-muted-foreground uppercase tracking-wide",
      };
      const cls = sizes[block.level] ?? sizes[4];
      return (
        <p key={key} className={cls}>
          {renderInline(block.text)}
        </p>
      );
    }
    case "code":
      return (
        <pre
          key={key}
          className="rounded border border-border/40 bg-secondary/40 p-2 overflow-x-auto text-[11.5px] font-mono"
        >
          <code>{block.text}</code>
        </pre>
      );
    case "ul":
      return (
        <ul
          key={key}
          className="list-disc list-inside space-y-1 marker:text-muted-foreground"
        >
          {block.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol
          key={key}
          className="list-decimal list-inside space-y-1 marker:text-muted-foreground"
        >
          {block.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-border/60 pl-3 italic text-muted-foreground"
        >
          {renderInline(block.text)}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="border-border/30" />;
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full text-[11.5px] border-collapse">
            <thead>
              <tr className="border-b border-border/60">
                {block.header.map((h, j) => (
                  <th
                    key={j}
                    className="text-left font-semibold px-2 py-1 text-foreground"
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr
                  key={j}
                  className="border-b border-border/20 last:border-0 hover:bg-secondary/30"
                >
                  {row.map((cell, k) => (
                    <td key={k} className="px-2 py-1 align-top">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "para":
      return <p key={key}>{renderInline(block.text)}</p>;
  }
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-secondary/60 px-1 py-0.5 font-mono text-[11.5px]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
