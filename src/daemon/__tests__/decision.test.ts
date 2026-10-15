import { describe, expect, it, vi } from "vitest";
import {
  buildDecisionRequest,
  decisionEnv,
  MAX_STATE_CHARS,
  requestRunDecision,
  severityFromProbabilities,
} from "../decision";

const answers = {
  severity: {
    type: "score",
    score: 1.85,
    confidence: 0.75,
    probabilities: { "0": 0.05, "1": 0.1, "2": 0.8, "3": 0.05 },
  },
  follow_up_needed: { type: "noul", noul: 0.86 },
  failure_kind: {
    type: "choice",
    choice: "auth_expired",
    confidence: 0.39,
    probabilities: { auth_expired: 0.48, timeout: 0.45, none: 0.07 },
  },
};
const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const served = {
  id: "gen-dec-1",
  provider: "TypeSafe",
  model: "typesafe/jev-1.13-20260917",
  answers,
  usage: { input_tokens: 5256, output_tokens: 114, cost: 0.000220752 },
};
const input = {
  jobName: "Executive Review",
  status: "success" as const,
  exitCode: 0,
  output: "=== Done ===\nall good",
};
const options = (fetchMock: typeof fetch) => ({
  apiKey: "k",
  baseUrl: "https://openrouter.ai/api",
  model: "typesafe/jev-1.13",
  fetch: fetchMock,
  retryDelayMs: 0,
});

describe("decision request", () => {
  it("sends the run state and the three typed questions to the System One endpoint with a bearer key", async () => {
    const fetchMock = vi.fn(async () => reply(served));
    await requestRunDecision(
      input,
      options(fetchMock as unknown as typeof fetch),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toMatchObject({
      job_name: "Executive Review",
      job_status: "success",
      exit_code: 0,
      output_tail: "=== Done ===\nall good",
    });
    expect(Object.keys(body.questions).sort()).toEqual([
      "failure_kind",
      "follow_up_needed",
      "severity",
    ]);
    expect(body.questions.severity).toMatchObject({ type: "score" });
    expect(body.questions.severity.criteria).toHaveLength(4);
    expect(body.questions.follow_up_needed.type).toBe("noul");
    expect(body.questions.failure_kind.type).toBe("choice");
  });

  it("parses answers into a severity label, follow-up flag and usage with the reported cost", async () => {
    const result = await requestRunDecision(
      input,
      options(vi.fn(async () => reply(served)) as unknown as typeof fetch),
    );
    expect(result.error).toBeNull();
    expect(result.decision).toMatchObject({
      model: "typesafe/jev-1.13-20260917",
      requestId: "gen-dec-1",
      provider: "TypeSafe",
      severity: { label: "warning", score: 1.85, confidence: 0.75 },
      followUp: { probability: 0.86, needed: true },
      failureKind: { choice: "auth_expired", confidence: 0.39 },
    });
    expect(result.decision?.severity.probabilities).toEqual({
      ok: 0.05,
      info: 0.1,
      warning: 0.8,
      critical: 0.05,
    });
    expect(result.decision?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      requests: 1,
      inputTokens: 5256,
      outputTokens: 114,
      costUsd: 0.000220752,
      model: "typesafe/jev-1.13-20260917",
    });
  });

  it("leaves the cost unavailable, not zero, when the provider reports no usage.cost", async () => {
    const result = await requestRunDecision(
      input,
      options(
        vi.fn(async () =>
          reply({ ...served, usage: { input_tokens: 10, output_tokens: 1 } }),
        ) as unknown as typeof fetch,
      ),
    );
    expect(result.usage).toMatchObject({
      requests: 1,
      inputTokens: 10,
      costUsd: null,
    });
    expect(result.decision).not.toBeNull();
  });

  it("keeps only the tail of a long log inside the state budget", () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
    const tail = buildDecisionRequest(
      { ...input, output: lines.join("\n") },
      "m",
    ).state.output_tail;
    expect(tail.split("\n")).toHaveLength(200);
    expect(tail.endsWith("line 999")).toBe(true);
    const huge = buildDecisionRequest(
      { ...input, output: "x".repeat(MAX_STATE_CHARS * 3) + "END" },
      "m",
    ).state.output_tail;
    expect(huge.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(huge.endsWith("END")).toBe(true);
  });

  it("drops MCP connector status notices from the log Jev reads, keeping the run's own outcome", () => {
    // Shapes copied from approve-prs / babysit-prs / answer-pr-comments logs of 2026-10-02 and 2026-10-05.
    const output = [
      "PREFLIGHT_CANDIDATES: 0",
      "**Servers that failed to connect:** cognee and oncrawl (both CONNECTION_CLOSED). Neither was needed for this run.No converged PRs to approve.",
      "- The `cognee` and `oncrawl` MCP servers failed to connect (CONNECTION_CLOSED), and `context7` needs OAuth authorization.",
      "No GHE connection failures. The context7 MCP server needs authorization (`/mcp` in an interactive session) and the oncrawl and cognee MCP servers failed to connect.",
      "**MCP servers needing authorization (non-interactive session):** claude.ai Atlassian Rovo, Excalidraw, Figma, Google Drive, Mermaid Chart, Notion, PostHog, and plugin:context7.",
      "AUTH_STATUS: github.groupondev.com auth check failed - retrying in 15s",
      "Error: server failed to connect to postgres at db:5432",
      "Results written to claude.ai/export.json.",
      // The job's own problems, which merely mention an MCP tool or server, must survive.
      "Both are commented out — Google Calendar OAuth isn't configured, so `bun run prep` can't fetch calendar events for its own script (separate from the Google Calendar MCP tool I used).",
      "The echelon-prod MCP server failed to connect, so the team roster could not be refreshed.",
      "Several MCP servers need authorization before they can be used.",
    ].join("\n");
    const tail = buildDecisionRequest({ ...input, output }, "m").state
      .output_tail;
    expect(tail).not.toMatch(
      /cognee|oncrawl|context7|CONNECTION_CLOSED|needs? (OAuth )?authori[sz]ation/i,
    );
    for (const kept of [
      "PREFLIGHT_CANDIDATES: 0",
      "No converged PRs to approve.",
      "No GHE connection failures.",
      "AUTH_STATUS: github.groupondev.com auth check failed - retrying in 15s",
      "Error: server failed to connect to postgres at db:5432",
      "Results written to claude.ai/export.json.",
      "Google Calendar OAuth isn't configured, so `bun run prep` can't fetch calendar events",
      "The echelon-prod MCP server failed to connect, so the team roster could not be refreshed.",
    ])
      expect(tail).toContain(kept);
    expect(tail).not.toContain("Several MCP servers need authorization");
    // The bullet that was nothing but a connector notice leaves no empty line behind.
    expect(tail.split("\n").filter((line) => !line.trim())).toHaveLength(0);
  });

  it("counts the 200-line tail after the connector notices are gone", () => {
    const lines = [
      ...Array.from({ length: 300 }, (_, index) => `line ${index}`),
      ...Array.from(
        { length: 50 },
        () => "The cognee and oncrawl MCP servers failed to connect.",
      ),
    ];
    const tail = buildDecisionRequest(
      { ...input, output: lines.join("\n") },
      "m",
    ).state.output_tail;
    expect(tail.split("\n")).toHaveLength(200);
    expect(tail.endsWith("line 299")).toBe(true);
  });

  it("retries once on a rate limit and reports the failure instead of throwing", async () => {
    const fetchMock = vi.fn(async () => reply({ error: "slow down" }, 429));
    const result = await requestRunDecision(
      input,
      options(fetchMock as unknown as typeof fetch),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.decision).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.error).toContain("429");
  });

  it("recovers when the retry succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ error: "overloaded" }, 529))
      .mockResolvedValueOnce(reply(served));
    const result = await requestRunDecision(
      input,
      options(fetchMock as unknown as typeof fetch),
    );
    expect(result.decision?.severity.label).toBe("warning");
  });

  it("returns an error for malformed answers and never calls the API without a key", async () => {
    const malformed = await requestRunDecision(
      input,
      options(
        vi.fn(async () =>
          reply({
            model: "m",
            answers: {},
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        ) as unknown as typeof fetch,
      ),
    );
    expect(malformed.decision).toBeNull();
    expect(malformed.error).toMatch(/answers/i);
    const fetchMock = vi.fn();
    const missing = await requestRunDecision(input, {
      ...options(fetchMock as unknown as typeof fetch),
      apiKey: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(missing.error).toContain("TYPESAFE_API_KEY");
  });

  it("times out a hung request", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const result = await requestRunDecision(input, {
      ...options(hang as unknown as typeof fetch),
      timeoutMs: 5,
    });
    expect(result.decision).toBeNull();
    expect(result.error).toMatch(/abort|timed out/i);
  });
});

describe("decision helpers", () => {
  it("maps score levels to labels and resolves ties toward the more severe level", () => {
    expect(
      severityFromProbabilities({ "0": 0.7, "1": 0.3, "2": 0, "3": 0 }),
    ).toBe("ok");
    expect(
      severityFromProbabilities({ "0": 0.1, "1": 0.45, "2": 0.45, "3": 0 }),
    ).toBe("warning");
    expect(severityFromProbabilities({ "0": 0, "1": 0, "2": 0, "3": 1 })).toBe(
      "critical",
    );
  });

  it("reads the TypeSafe environment with the documented defaults", () => {
    expect(decisionEnv({})).toEqual({
      apiKey: null,
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
    });
    expect(
      decisionEnv({
        TYPESAFE_API_KEY: "k",
        TYPESAFE_BASE_URL: "https://openrouter.ai/api/",
        TYPESAFE_DEFAULT_MODEL: "typesafe/jev-1.13",
      }),
    ).toEqual({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api",
      model: "typesafe/jev-1.13",
    });
  });
});
