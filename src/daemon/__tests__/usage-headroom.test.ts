import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// scripts/usage-headroom.py (2026-10-16): the headroom gauge's parser and files, driven by a
// response read from a file. The live call (keychain token, the usage endpoint) is not exercised
// here; the first scheduled run under launchd is its probe.

const SCRIPT = path.resolve(__dirname, "../../../scripts/usage-headroom.py");
const FIXTURE = path.join(__dirname, "fixtures", "usage-headroom-sample.json");

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sched-headroom-"));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const run = (...args: string[]): string =>
  execFileSync("python3", ["-I", SCRIPT, "--out", tmpDir, "--host", "TESTHOST", ...args], { encoding: "utf8" });
const latest = () => JSON.parse(fs.readFileSync(path.join(tmpDir, "latest.json"), "utf8"));
const ledger = () =>
  fs.readFileSync(path.join(tmpDir, "headroom.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("usage-headroom.py", () => {
  it("reads the windows out of a response and writes latest.json plus a ledger line", () => {
    const out = run("--from-file", FIXTURE);
    expect(out).toMatch(/^usage-headroom: ok \(5-hour 24% resets 2026-10-16T16:00:00\+00:00, 7-day 61% resets/);
    const sample = latest();
    expect(sample).toMatchObject({
      version: 1,
      host: "TESTHOST",
      status: "ok",
      http: 200,
      source: "file",
      parsed: true,
      windows: {
        five_hour: { label: "5-hour", utilization_percent: 23.5, assumed_fraction: false, resets_at: "2026-10-16T16:00:00+00:00" },
        seven_day: { label: "7-day", utilization_percent: 61 },
        seven_day_opus: { label: "7-day Opus", utilization_percent: 80.25 },
      },
      error: null,
    });
    expect(sample.windows.extra_usage).toBeUndefined(); // no figure, no reset: not a window
    expect(sample.raw.seven_day_opus.utilization).toBe(80.25);
    expect(sample.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const lines = ledger();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "ok", windows: { seven_day: { utilization_percent: 61 } } });
    expect(lines[0].raw).toBeUndefined();
  });

  it("keeps the raw body and says parsed: false when the shape is new, and appends to the ledger", () => {
    const strange = path.join(tmpDir, "strange.json");
    fs.writeFileSync(strange, JSON.stringify({ limits: [{ window: "5h", used: 0.4 }], note: "x" }));
    run("--from-file", FIXTURE);
    const out = run("--from-file", strange);
    expect(out).toContain("no known window in the response; raw kept");
    expect(latest()).toMatchObject({ status: "ok", parsed: false, windows: {}, raw: { note: "x" } });
    expect(ledger()).toHaveLength(2);
  });

  it("reads a 0-1 figure as a fraction and flags it", () => {
    const fraction = path.join(tmpDir, "fraction.json");
    fs.writeFileSync(fraction, JSON.stringify({ five_hour: { utilization: 0.42 }, seven_day: { resets_at: "2026-10-18T03:00:00Z" } }));
    run("--from-file", fraction);
    expect(latest().windows).toMatchObject({
      five_hour: { utilization_percent: 42, assumed_fraction: true, resets_at: null },
      seven_day: { utilization_percent: null, resets_at: "2026-10-18T03:00:00Z" },
    });
  });

  it("records an unreadable file or non-JSON as unavailable and still exits 0", () => {
    expect(run("--from-file", path.join(tmpDir, "missing.json"))).toMatch(/^usage-headroom: unavailable \(read .*missing\.json/);
    expect(latest()).toMatchObject({ status: "unavailable", parsed: false, windows: {} });
    const html = path.join(tmpDir, "login.html");
    fs.writeFileSync(html, "<html>sign in</html>");
    expect(run("--from-file", html)).toContain("response is not JSON");
    expect(latest()).toMatchObject({ status: "unavailable", raw: "<html>sign in</html>" });
    expect(ledger()).toHaveLength(2);
  });
});
