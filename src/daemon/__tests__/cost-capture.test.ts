import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJob } from "../job-runner";
import { evaluateRun } from "../evaluator";
import { readRunCost } from "../costs";
import { getLogPath, getRunDir } from "@shared/paths";
import type { JobConfig } from "@shared/types";

let root: string;
let job: JobConfig;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-cost-capture-"));
  job = { name: "Cost test", type: "claude", schedule: "0 0 * * *", directory: root, prompt: "test", enabled: false, tags: [] };
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function fakeClaude(source: string): void {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}

describe("runtime cost capture", () => {
  it("captures split native results including the final unterminated line", async () => {
    fakeClaude(`
      process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"héllo"}]}})+"\\n");
      process.stdout.write('{"type":"res');
      setTimeout(() => process.stdout.write('ult","total_cost_usd":0.4,"usage":{"input_tokens":10,"output_tokens":20}}'), 10);
    `);
    const run = await runJob({ jobId: "job", jobConfig: job, projectRoot: root, trigger: "manual" });
    expect(run.status).toBe("success");
    expect(readRunCost(root, "job", run.runId)).toMatchObject({ executionCostUsd: 0.4, evaluationState: "pending" });
    expect(fs.readFileSync(getLogPath(root, "job", run.runId), "utf8")).toContain("héllo");
  });

  it("keeps failed attempts in the cost of a retried run", async () => {
    fakeClaude(`
      const fs = require("node:fs");
      const retry = fs.existsSync("attempted");
      fs.writeFileSync("attempted", "yes");
      process.stdout.write(JSON.stringify({type:"result",total_cost_usd:retry?0.2:0.1})+"\\n");
      process.exitCode = retry ? 0 : 1;
    `);
    const run = await runJob({ jobId: "job", jobConfig: job, projectRoot: root, trigger: "manual", maxRetries: 1 });
    const cost = readRunCost(root, "job", run.runId);
    expect(cost.executionCostUsd).toBe(0.3);
    expect(cost.attempts).toHaveLength(2);
  });

  it("records script tasks without changing their text logs", async () => {
    const output = 'préparation\n{"type":"scheduler_cost","id":"prep","currency":"USD","cost_usd":0.125}\n{"type":"scheduler_cost_complete"}';
    const run = await runJob({
      jobId: "job", jobConfig: { ...job, type: "script", command: "unused", prompt: undefined },
      projectRoot: root, trigger: "manual", command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
    });
    const cost = readRunCost(root, "job", run.runId);
    expect(cost.executionCostUsd).toBe(0.125);
    expect(cost.attempts[0].complete).toBe(true);
    expect(fs.readFileSync(getLogPath(root, "job", run.runId), "utf8")).toBe(output);
  });

  it("does not infer zero costs for uninstrumented scripts or failed spawns", async () => {
    const run = await runJob({ jobId: "job", jobConfig: job, projectRoot: root, trigger: "manual", command: "/nonexistent/cost-test" });
    expect(readRunCost(root, "job", run.runId)).toMatchObject({ totalCostUsd: null, coverage: "unavailable" });
  });

  it("captures evaluator overhead and still parses the wrapped evaluation", async () => {
    fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
    fakeClaude(`
      const args = process.argv.slice(2);
      if (!args.includes("json")) process.exit(1);
      process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0.005,result:JSON.stringify({summary:"Done",severity:"ok",followUpNeeded:false,followUpReason:null})}));
    `);
    const evaluation = await evaluateRun(root, "job", "run", "Test", "success", 0);
    expect(evaluation?.summary).toBe("Done");
    expect(readRunCost(root, "job", "run")).toMatchObject({ evaluationCostUsd: 0.005, coverage: "partial" });
  });

  it("preserves evaluator costs even when its assessment is invalid", async () => {
    fs.mkdirSync(getRunDir(root, "job", "run"), { recursive: true });
    fakeClaude('process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0.003,result:"not JSON"}));');
    expect(await evaluateRun(root, "job", "run", "Test", "success", 0)).toBeNull();
    expect(readRunCost(root, "job", "run").evaluationCostUsd).toBe(0.003);
  });
});
