import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  RunGraph,
  RunGraphAttempt,
  RunGraphCall,
  RunGraphLane,
  RunGraphStep,
  ToolCategory,
} from "../../../shared/run-graph-types";
import { RunDiagramView } from "../run-diagram/view";

// Fixtures follow the shape of a real capture (Glob, Reads, a failed Read of a
// missing file, an async Agent subagent, an MCP call) from Claude Code 2.1.283.

const START = "2026-09-28T10:00:00.000Z";
let sequence = 0;

function call(overrides: Partial<RunGraphCall> = {}): RunGraphCall {
  sequence += 1;
  return {
    id: `toolu_${sequence}`,
    name: "Read",
    label: "Read",
    server: null,
    category: "read",
    summary: `/tmp/sample/file-${sequence}.txt`,
    path: null,
    status: "ok",
    startedAt: null,
    durationMs: 40,
    resultPreview: null,
    subagent: null,
    ...overrides,
  };
}

function step(
  id: string,
  calls: RunGraphCall[],
  overrides: Partial<RunGraphStep> = {},
): RunGraphStep {
  return { id, startedAt: null, narration: null, calls, ...overrides };
}

function lane(
  steps: RunGraphStep[],
  overrides: Partial<RunGraphLane> = {},
): RunGraphLane {
  return {
    id: "main",
    label: "main",
    subagentType: null,
    status: "ok",
    summary: null,
    toolUses: null,
    durationMs: null,
    steps,
    ...overrides,
  };
}

function attempt(overrides: Partial<RunGraphAttempt> = {}): RunGraphAttempt {
  return {
    attempt: 1,
    startedAt: START,
    model: "claude-haiku-4-5-20251001",
    lane: null,
    sections: [],
    outcome: null,
    truncated: false,
    ...overrides,
  };
}

function byCategory(
  counts: Partial<Record<ToolCategory, number>>,
): Record<ToolCategory, number> {
  return {
    read: 0,
    search: 0,
    edit: 0,
    shell: 0,
    web: 0,
    agent: 0,
    skill: 0,
    mcp: 0,
    plan: 0,
    other: 0,
    ...counts,
  };
}

function graph(overrides: Partial<RunGraph> = {}): RunGraph {
  return {
    jobId: "demo",
    runId: "2026-09-28T10-00-00-abc123",
    kind: "agent",
    source: "trace",
    status: "success",
    exitCode: 0,
    startedAt: START,
    finishedAt: "2026-09-28T10:04:12.000Z",
    attempts: [attempt({ lane: lane([]) })],
    totals: {
      toolCalls: 0,
      errors: 0,
      subagents: 0,
      steps: 0,
      byCategory: byCategory({}),
      filesRead: [],
      filesChanged: [],
    },
    notes: [],
    ...overrides,
  };
}

function render(
  value: RunGraph,
  trigger: string | null = "manual",
  directory: string | null = null,
): string {
  return renderToStaticMarkup(
    createElement(RunDiagramView, {
      graph: value,
      trigger,
      directory,
      now: Date.parse("2026-09-28T10:05:00.000Z"),
    }),
  );
}

function occurrences(html: string, text: string): number {
  return html.split(text).length - 1;
}

function failedAgentRun(): RunGraph {
  const subagent = lane(
    [
      step("sub-1", [
        call({ summary: "/tmp/sample/b.txt" }),
        call({
          name: "Bash",
          label: "Bash",
          category: "shell",
          summary: "$ wc -w nested-secret.txt",
          status: "error",
          resultPreview: "wc: nested-secret.txt: open: No such file",
        }),
      ]),
    ],
    {
      id: "toolu_agent",
      label: "count words",
      subagentType: "general-purpose",
      toolUses: 2,
      durationMs: 3681,
      summary: "The file b.txt contains 1 word: world",
    },
  );
  const main = lane([
    step(
      "m-1",
      [
        call({
          name: "Glob",
          label: "Glob",
          category: "search",
          summary: "*.txt",
        }),
      ],
      {
        startedAt: "2026-09-28T10:00:02.000Z",
        narration: "I'll look at the text files first.",
      },
    ),
    step(
      "m-2",
      Array.from({ length: 12 }, (_, index) =>
        call({ summary: `/tmp/sample/part-${index + 1}.txt` }),
      ),
      { startedAt: "2026-09-28T10:00:05.000Z" },
    ),
    step(
      "m-3",
      [
        call({
          summary: "/tmp/sample/missing.txt",
          status: "error",
          resultPreview:
            "File does not exist. Note: your current working directory is /tmp/sample.",
        }),
      ],
      { startedAt: "2026-09-28T10:01:12.400Z" },
    ),
    step("m-4", [
      call({
        name: "Agent",
        label: "Agent",
        category: "agent",
        summary: "count words",
        durationMs: 12,
        subagent,
      }),
    ]),
    step("m-5", [
      call({
        name: "mcp__atlassian__jira_get_issue",
        label: "jira_get_issue",
        server: "atlassian",
        category: "mcp",
        summary: "PROJ-42",
        status: "pending",
        durationMs: null,
      }),
    ]),
  ]);
  return graph({
    status: "failed",
    exitCode: 1,
    attempts: [
      attempt({
        lane: main,
        outcome: {
          isError: true,
          subtype: "error_during_execution",
          durationMs: 250_000,
          numTurns: 9,
          costUsd: 0.181,
          permissionDenials: 2,
          text: "Could not finish: missing.txt was not found.",
        },
      }),
    ],
    totals: {
      toolCalls: 18,
      errors: 2,
      subagents: 1,
      steps: 6,
      byCategory: byCategory({
        read: 14,
        search: 1,
        agent: 1,
        shell: 1,
        mcp: 1,
      }),
      filesRead: ["/tmp/sample/a.txt", "/tmp/sample/b.txt"],
      filesChanged: ["/tmp/sample/out.txt"],
    },
    notes: [
      "Subagent usage is reported by the CLI and may exceed the calls shown.",
    ],
  });
}

describe("RunDiagramView (agent runs)", () => {
  const html = render(failedAgentRun());

  it("summarizes the trace source, calls, steps, subagents and errors", () => {
    for (const text of [
      "Traced",
      "18 tool calls",
      "6 steps",
      "1 subagent",
      "2 errors",
      "4m 12s",
    ])
      expect(html).toContain(text);
  });

  it("describes the category bar in text for assistive technology", () => {
    expect(html).toContain(
      'aria-label="Tool calls by category: Read 14, Search 1, Shell 1, Agent 1, MCP 1"',
    );
  });

  it("shows a failed call with its result preview and never folds it into the Read group", () => {
    expect(html).toContain(
      "File does not exist. Note: your current working directory is /tmp/sample.",
    );
    expect(html).toContain("/tmp/sample/missing.txt");
    expect(html).toContain("Read ×12");
    expect(html).not.toContain("Read ×13");
  });

  it("collapses the 12 consecutive reads to one row with the first summary", () => {
    expect(html).toContain("/tmp/sample/part-1.txt");
    expect(html).toContain("and 11 more");
    expect(html).not.toContain("/tmp/sample/part-2.txt");
  });

  it("shows the subagent row with its nested error count while keeping its lane collapsed", () => {
    for (const text of [
      "count words",
      "general-purpose",
      "2 tool uses",
      "1 error",
      "3.6s",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("nested-secret.txt");
    expect(html).toContain("The file b.txt contains 1 word: world");
  });

  it("labels an MCP call with its server and an unanswered call as having no result", () => {
    expect(html).toContain("jira_get_issue");
    expect(html).toContain("atlassian");
    expect(html).toContain("no result");
  });

  it("shows step offsets from the attempt start and the narration", () => {
    expect(html).toContain("+1m 12s");
    expect(html).toContain("I&#x27;ll look at the text files first.");
  });

  it("ends with the run status, exit code, turns, cost, denials and final result", () => {
    for (const text of [
      "failed",
      "exit 1",
      "9 turns",
      "$0.18",
      "2 permission denials",
      "Could not finish: missing.txt was not found.",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("starts with the trigger, model and start time", () => {
    expect(html).toContain("manual");
    expect(html).toContain("claude-haiku-4-5-20251001");
    expect(html).toContain(`dateTime="${START}"`);
  });

  it("renders notes and the files disclosure with changed files first", () => {
    expect(html).toContain(
      "Subagent usage is reported by the CLI and may exceed the calls shown.",
    );
    expect(html).toContain("Files · 2 read · 1 changed");
    expect(html.indexOf("out.txt")).toBeLessThan(html.indexOf("a.txt"));
  });

  it("uses buttons with aria-expanded for collapsible rows and an ordered list for steps", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<ol aria-label="Steps"');
    expect(html).not.toContain('aria-expanded="true"');
  });
});

describe("RunDiagramView (large and edge-case runs)", () => {
  it("windows a long lane to its first 20 and last 10 steps", () => {
    const steps = Array.from({ length: 45 }, (_, index) =>
      step(`s-${index + 1}`, [call()]),
    );
    const html = render(graph({ attempts: [attempt({ lane: lane(steps) })] }));
    expect(html).toContain("Show 15 more steps");
    for (const label of ["Step 1<", "Step 20<", "Step 36<", "Step 45<"])
      expect(html).toContain(label);
    for (const label of ["Step 21<", "Step 30<", "Step 35<"])
      expect(html).not.toContain(label);
  });

  it("shows 8 rows of a step with more than 12 and offers the rest", () => {
    const calls = Array.from({ length: 13 }, (_, index) =>
      index % 2 === 0
        ? call({ summary: `/tmp/r-${index}` })
        : call({
            name: "Bash",
            label: "Bash",
            category: "shell",
            summary: `$ echo ${index}`,
          }),
    );
    const html = render(
      graph({ attempts: [attempt({ lane: lane([step("s-1", calls)]) })] }),
    );
    expect(html).toContain("Show 5 more");
    expect(html).toContain("$ echo 7");
    expect(html).not.toContain("$ echo 9");
  });

  it("says when an agent run recorded no tool activity", () => {
    expect(render(graph())).toContain(
      "No tool activity was recorded for this run.",
    );
  });

  it("gives each attempt a header with its outcome and marks the retry start", () => {
    const first = attempt({
      outcome: {
        isError: true,
        subtype: "error_max_turns",
        durationMs: 1000,
        numTurns: 30,
        costUsd: null,
        permissionDenials: 0,
        text: null,
      },
      lane: lane([step("a1", [call()])]),
    });
    const second = attempt({
      attempt: 2,
      startedAt: "2026-09-28T10:02:00.000Z",
      lane: lane([step("a2", [call()])]),
    });
    const html = render(graph({ attempts: [first, second] }));
    expect(html).toContain("Attempt 1");
    // Header and End node both name the retried attempt's result subtype.
    expect(occurrences(html, "error max turns · retried")).toBe(2);
    expect(html).not.toContain("no result · retried");
    expect(html).toContain("Attempt 2");
    expect(html).toContain("retry");
  });

  it("colours a partial retried attempt amber and a failed one red", () => {
    const retried = (attemptNumber: number, subtype: string) =>
      attempt({
        attempt: attemptNumber,
        outcome: {
          isError: true,
          subtype,
          durationMs: null,
          numTurns: null,
          costUsd: null,
          permissionDenials: 0,
          text: null,
        },
        lane: lane([step(`r-${attemptNumber}`, [call()])]),
      });
    const html = render(
      graph({
        source: "log",
        attempts: [
          retried(1, "partial"),
          retried(2, "failed"),
          attempt({ attempt: 3, lane: lane([step("r-3", [call()])]) }),
        ],
      }),
    );
    expect(html).toContain(
      '<span class="font-normal text-amber-700 dark:text-amber-400">partial · retried</span>',
    );
    expect(html).toContain(
      '<span class="font-normal text-red-700 dark:text-red-400">failed · retried</span>',
    );
  });

  it("does not repeat the final narration as the End node's result", () => {
    const final = "All three files were read; b.txt says world.";
    const html = render(
      graph({
        attempts: [
          attempt({
            lane: lane([
              step("f-1", [call()], { narration: "Reading the files." }),
              step("f-2", [], { narration: final }),
            ]),
            outcome: {
              isError: false,
              subtype: "success",
              durationMs: 4000,
              numTurns: 2,
              costUsd: null,
              permissionDenials: 0,
              text: `${final}\n`,
            },
          }),
        ],
      }),
    );
    expect(occurrences(html, final)).toBe(1);
    expect(html).toContain("2 turns");
  });

  it("counts the files header by the rows listed, so a file read and then edited counts once, as changed", () => {
    const base = graph();
    const html = render(
      graph({
        totals: {
          ...base.totals,
          // a.ts was read and then edited; b.ts was only read.
          filesRead: ["/tmp/sample/a.ts", "/tmp/sample/b.ts"],
          filesChanged: ["/tmp/sample/a.ts"],
        },
      }),
    );
    expect(html).toContain("Files · 1 read · 1 changed");
  });

  it("gives the diagram an h2 so the attempt h3s nest under it", () => {
    const html = render(
      graph({
        attempts: [
          attempt({ lane: lane([step("h-1", [call()])]) }),
          attempt({ attempt: 2, lane: lane([step("h-2", [call()])]) }),
        ],
      }),
    );
    expect(html).toContain('<h2 class="sr-only">Run diagram</h2>');
    expect(html.indexOf("<h2")).toBeLessThan(html.indexOf("<h3"));
  });

  it("keeps parallel calls in one group while some are pending and says how many", () => {
    const calls = () => [
      call({ id: "toolu_par_1", status: "ok" }),
      call({ id: "toolu_par_2", status: "pending", durationMs: null }),
      call({ id: "toolu_par_3", status: "pending", durationMs: null }),
    ];
    const live = render(
      graph({
        status: "running",
        exitCode: null,
        finishedAt: null,
        attempts: [attempt({ lane: lane([step("par", calls())]) })],
      }),
    );
    expect(live).toContain("Read ×3");
    expect(live).toContain("2 in progress");
    const finished = render(
      graph({ attempts: [attempt({ lane: lane([step("par", calls())]) })] }),
    );
    expect(finished).toContain("Read ×3");
    expect(finished).toContain("2 no result");
  });

  it("shows live progress for a running run", () => {
    const running = graph({
      status: "running",
      exitCode: null,
      finishedAt: null,
      attempts: [
        attempt({
          lane: lane([
            step("r-1", [call({ status: "pending", durationMs: null })]),
          ]),
        }),
      ],
    });
    const html = render(running);
    expect(html).toContain("in progress");
    expect(html).toContain("Running…");
    expect(html).toContain("5m elapsed");
    expect(html).not.toContain("no result");
  });
});

describe("RunDiagramView (log reconstructions)", () => {
  const logRun = (agentCalls: number) =>
    graph({
      source: "log",
      attempts: [attempt({ lane: lane([step("l-1", [call()])]) })],
      totals: {
        toolCalls: 20 + agentCalls,
        errors: 0,
        subagents: 0,
        steps: 5,
        byCategory: byCategory({ read: 20, agent: agentCalls }),
        filesRead: [],
        filesChanged: [],
      },
    });

  it("says outcomes were not recorded and counts agent calls instead of subagents", () => {
    const html = render(logRun(16));
    for (const text of [
      "Reconstructed from log",
      "36 tool calls",
      "5 steps",
      "16 agent calls",
      "outcomes not recorded",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("0 subagents");
    expect(html).not.toContain("0 errors");
  });

  it("omits the agent count when no agent calls were made", () => {
    const html = render(logRun(0));
    expect(html).not.toContain("agent call");
    expect(html).not.toContain("subagent");
    expect(html).toContain("outcomes not recorded");
  });
});

describe("RunDiagramView (paths)", () => {
  const directory = "/Users/me/Programming/proj";
  const html = render(
    graph({
      attempts: [
        attempt({
          lane: lane([
            step("p-1", [
              call({ summary: `${directory}/src/app.ts` }),
              call({
                name: "Edit",
                label: "Edit",
                category: "edit",
                summary: "/Users/me/other/notes.md",
              }),
            ]),
            step("p-2", [
              call({ summary: `${directory}/src/a.ts` }),
              call({ summary: `${directory}/src/b.ts` }),
            ]),
          ]),
        }),
      ],
      totals: {
        toolCalls: 4,
        errors: 0,
        subagents: 0,
        steps: 2,
        byCategory: byCategory({ read: 3, edit: 1 }),
        filesRead: [`${directory}/src/app.ts`],
        filesChanged: ["/Users/me/other/notes.md"],
      },
    }),
    "manual",
    directory,
  );

  it("shows call summaries relative to the job directory, with the full path as the title", () => {
    expect(html).toContain(`title="${directory}/src/app.ts">src/app.ts</span>`);
    expect(html).toContain(`title="${directory}/src/a.ts">src/a.ts</span>`);
  });

  it("collapses the home directory for paths outside the job directory", () => {
    expect(html).toContain(
      'title="/Users/me/other/notes.md">~/other/notes.md</span>',
    );
  });

  it("lists files relative to the job directory and keeps the full path as the title", () => {
    expect(html).toContain(`title="${directory}/src/app.ts"><span`);
    expect(html).toContain(">src/</span>");
    expect(html).toContain(">~/other/</span>");
    expect(html).not.toContain(">/Users/me/Programming/proj/src/</span>");
  });
});

describe("RunDiagramView (script runs)", () => {
  it("renders output sections with failures and issues", () => {
    const html = render(
      graph({
        kind: "script",
        source: "script-log",
        status: "failed",
        exitCode: 2,
        attempts: [
          attempt({
            model: null,
            sections: [
              {
                id: "sec-1",
                title: "Install dependencies",
                lineCount: 12,
                failed: false,
                issueCount: 0,
                firstIssue: null,
              },
              {
                id: "sec-2",
                title: "Run tests",
                lineCount: 40,
                failed: true,
                issueCount: 3,
                firstIssue: "FAILED src/a.test.ts adds numbers",
              },
            ],
          }),
        ],
      }),
      "scheduled",
    );
    for (const text of [
      "Script sections",
      "2 sections",
      "1 failed",
      "3 issues",
      "Install dependencies",
      "Run tests",
      "FAILED",
      "FAILED src/a.test.ts adds numbers",
      "exit 2",
      "scheduled",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("tool call");
  });
});

// WCAG 1.4.11: a graphic that is the only visual cue for a state needs 3:1
// against its background. Colours come from the real tokens: the card surface
// in globals.css and Tailwind's palette, converted OKLCH -> linear sRGB.
describe("RunDiagramView (in-progress indicator contrast)", () => {
  const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
  const globalsCss = fs.readFileSync(`${ROOT}src/web/app/globals.css`, "utf8");
  const paletteCss = fs.readFileSync(
    `${ROOT}node_modules/tailwindcss/theme.css`,
    "utf8",
  );
  type Oklch = [number, number, number];

  function cssVar(css: string, name: string): Oklch {
    const match = new RegExp(
      `--${name}:\\s*oklch\\(\\s*([\\d.]+)(%?)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`,
    ).exec(css);
    if (!match) throw new Error(`--${name} not found`);
    return [
      Number(match[1]) / (match[2] ? 100 : 1),
      Number(match[3]),
      Number(match[4]),
    ];
  }

  function block(selector: string): string {
    const start = globalsCss.indexOf(`${selector} {`);
    return globalsCss.slice(start, globalsCss.indexOf("}", start));
  }

  /** WCAG relative luminance of an OKLCH colour (Ottosson's OKLab matrices, clipped to sRGB). */
  function luminance([L, C, H]: Oklch): number {
    const a = C * Math.cos((H * Math.PI) / 180);
    const b = C * Math.sin((H * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const [red, green, blue] = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map((channel) => Math.min(1, Math.max(0, channel)));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  function contrast(x: Oklch, y: Oklch): number {
    const [high, low] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (high + 0.05) / (low + 0.05);
  }

  it("checks the converter against a known ratio (yellow-500 on the light card is 1.86:1)", () => {
    expect(
      contrast(
        cssVar(paletteCss, "color-yellow-500"),
        cssVar(block(":root"), "card"),
      ),
    ).toBeCloseTo(1.86, 2);
  });

  it("draws a steady in-progress dot with at least 3:1 on the card in light and dark themes", () => {
    const html = render(
      graph({
        status: "running",
        exitCode: null,
        finishedAt: null,
        attempts: [
          attempt({
            lane: lane([
              step("live", [call({ status: "pending", durationMs: null })]),
            ]),
          }),
        ],
      }),
    );
    const start = html.indexOf('title="In progress"');
    expect(start).toBeGreaterThan(-1);
    const mark = html.slice(start, html.indexOf("in progress</span>", start));
    const lightCard = cssVar(block(":root"), "card");
    const darkCard = cssVar(block(".dark"), "card");
    // An opacity animation would halve the dot's contrast at its trough, so only
    // an unanimated fill can carry the state.
    const steadyDots = [...mark.matchAll(/class="([^"]*)"/g)]
      .map((match) => match[1].split(/\s+/))
      .filter((classes) => !classes.some((name) => name.includes("animate-")))
      .flatMap((classes) => {
        const fill = classes.find((name) => /^bg-[a-z]+-\d{2,3}$/.test(name));
        if (!fill) return [];
        const darkFill =
          classes.find((name) => /^dark:bg-[a-z]+-\d{2,3}$/.test(name)) ??
          `dark:${fill}`;
        return [
          {
            light: contrast(
              cssVar(paletteCss, `color-${fill.slice(3)}`),
              lightCard,
            ),
            dark: contrast(
              cssVar(paletteCss, `color-${darkFill.slice(8)}`),
              darkCard,
            ),
          },
        ];
      });
    expect(steadyDots.length).toBeGreaterThan(0);
    for (const dot of steadyDots) {
      expect(dot.light).toBeGreaterThanOrEqual(3);
      expect(dot.dark).toBeGreaterThanOrEqual(3);
    }
  });
});
