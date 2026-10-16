import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRun, SECOND_OPINION_MODEL } from "../evaluator";
import { getLogPath, getRunDir } from "@shared/paths";

// Since 2026-10-16 the second opinion inside the uncertain band comes from Sonnet; the summary of
// a warning/critical/follow-up run outside the band still comes from Haiku.

let root: string;
let argvLog: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-second-opinion-"));
  fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
  fs.writeFileSync(getLogPath(root, "job", "run"), "no candidates\n");
  fs.writeFileSync(
    path.join(getRunDir(root, "job", "run"), "meta.json"),
    JSON.stringify({ jobId: "job", runId: "run", jobConfig: { name: "Job", directory: root, type: "script", command: "true", enabled: true, tags: [] }, trigger: "manual", startedAt: "2026-10-16T09:30:07.000Z" }),
  );
  fs.writeFileSync(
    path.join(getRunDir(root, "job", "run"), "status.json"),
    JSON.stringify({ status: "success", exitCode: 0, startedAt: "2026-10-16T09:30:07.000Z", finishedAt: "2026-10-16T09:30:20.000Z" }),
  );
  const bin = path.join(root, "bin");
  argvLog = path.join(root, "argv");
  fs.mkdirSync(bin, { recursive: true });
  // A fake `claude` that records the --model it was given and answers like the evaluator expects.
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
    const i = process.argv.indexOf("--model");
    require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, process.argv[i + 1] + "\\n");
    process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0.02,modelUsage:{["claude-" + process.argv[i + 1] + "-5-5"]:{inputTokens:10,outputTokens:5,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0.02}},result:JSON.stringify({summary:"ok",severity:"ok",followUpNeeded:false,followUpReason:null})}));
  `,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const jevReply = (followUp: number, severity: Record<string, number>) =>
  new Response(
    JSON.stringify({
      id: "gen-1",
      provider: "TypeSafe",
      model: "typesafe/jev-1.13-20260917",
      answers: {
        severity: { type: "score", score: 1, confidence: 0.6, probabilities: severity },
        follow_up_needed: { type: "noul", noul: followUp },
        failure_kind: { type: "choice", choice: "none", confidence: 0.4, probabilities: { none: 0.5, other: 0.5 } },
      },
      usage: { input_tokens: 800, output_tokens: 90, cost: 0.0000336 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const models = () => fs.readFileSync(argvLog, "utf8").trim().split("\n");

describe("which Claude model the enforce evaluator asks", () => {
  it("asks Sonnet for the second opinion in the band and records that model in the ledger", async () => {
    const fetchMock = vi.fn(async () => jevReply(0.58, { "0": 0.3, "1": 0.6, "2": 0.1, "3": 0 }));
    const evaluation = await evaluateRun(root, "job", "run", "Job", "success", 0, {
      decisionMode: "enforce",
      decision: { apiKey: "k", baseUrl: "https://openrouter.ai/api", model: "typesafe/jev-1.13", fetch: fetchMock as unknown as typeof fetch, retryDelayMs: 0 },
    });
    expect(SECOND_OPINION_MODEL).toBe("sonnet");
    expect(models()).toEqual(["sonnet"]);
    expect(evaluation).toMatchObject({ source: "jev+haiku", secondOpinion: { severity: "ok", followUpNeeded: false } });
    const dir = path.join(root, "data", "evaluations");
    const record = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").trim());
    expect(record.evaluation).toMatchObject({ haikuModel: "claude-sonnet-5-5", secondOpinion: { severity: "ok" } });
  });

  it("still asks Haiku for the summary of a flagged run outside the band", async () => {
    const fetchMock = vi.fn(async () => jevReply(0.86, { "0": 0.05, "1": 0.1, "2": 0.8, "3": 0.05 }));
    const evaluation = await evaluateRun(root, "job", "run", "Job", "failed", 1, {
      decisionMode: "enforce",
      decision: { apiKey: "k", baseUrl: "https://openrouter.ai/api", model: "typesafe/jev-1.13", fetch: fetchMock as unknown as typeof fetch, retryDelayMs: 0 },
    });
    expect(models()).toEqual(["haiku"]);
    expect(evaluation).toMatchObject({ severity: "warning", followUpNeeded: true, source: "jev+haiku" });
    expect(evaluation?.secondOpinion).toBeUndefined();
  });
});
