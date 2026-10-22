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

  // Pace (2026-10-22): the 7-day window's remaining allowance per remaining hour against the
  // nominal 100 points / 168 h, as a factor the review rounds multiply their budget by.
  describe("pace", () => {
    const sampleAt = (body: object, now: string): Record<string, unknown> => {
      const file = path.join(tmpDir, "body.json");
      fs.writeFileSync(file, JSON.stringify(body));
      run("--from-file", file, "--now", now);
      return latest().pace;
    };

    it("reads the fixture as hot: 61% used with 96 of 168 hours left (43% expected)", () => {
      run("--from-file", FIXTURE, "--now", "2026-10-14T03:00:00Z");
      expect(latest().pace).toEqual({
        state: "hot",
        factor: 0.68,
        utilization: 61,
        expected: 42.9,
        hours_left: 96,
        five_hour_brake: false,
        note: "61% used, 43% expected at this point of the week; 39 points left for 96 h: 0.68x the nominal rate",
      });
      expect(ledger()[0].pace).toMatchObject({ state: "hot", factor: 0.68 });
    });

    it("is on pace at factor 1.0 when used matches elapsed", () => {
      const pace = sampleAt({ seven_day: { utilization: 50, resets_at: "2026-10-18T15:00:00Z" } }, "2026-10-15T03:00:00Z");
      expect(pace).toMatchObject({ state: "on-pace", factor: 1, utilization: 50, expected: 50, hours_left: 84 });
    });

    it("has spare budget: factor above 1, clamped at 2.0", () => {
      const pace = sampleAt({ seven_day: { utilization: 10, resets_at: "2026-10-17T03:00:00Z" } }, "2026-10-15T03:00:00Z");
      expect(pace).toMatchObject({ state: "spare", factor: 2, hours_left: 48, expected: 71.4 });
    });

    it("clamps an exhausted week at 0.25 instead of 0", () => {
      const pace = sampleAt({ seven_day: { utilization: 100, resets_at: "2026-10-19T07:00:00Z" } }, "2026-10-15T03:00:00Z");
      expect(pace).toMatchObject({ state: "hot", factor: 0.25, hours_left: 100 });
    });

    it("brakes to 0.5 when the 5-hour window is nearly used, whatever the week says", () => {
      const pace = sampleAt(
        { five_hour: { utilization: 90, resets_at: "2026-10-15T06:00:00Z" }, seven_day: { utilization: 50, resets_at: "2026-10-18T15:00:00Z" } },
        "2026-10-15T03:00:00Z",
      );
      expect(pace).toMatchObject({ state: "on-pace", factor: 0.5, five_hour_brake: true });
    });

    it("is unknown at factor 1.0 without a 7-day figure, a reset time, or a usable sample", () => {
      expect(sampleAt({ five_hour: { utilization: 20, resets_at: "2026-10-15T06:00:00Z" } }, "2026-10-15T03:00:00Z")).toMatchObject({
        state: "unknown",
        factor: 1,
      });
      expect(sampleAt({ seven_day: { utilization: 20 } }, "2026-10-15T03:00:00Z")).toMatchObject({ state: "unknown", factor: 1 });
      // a reset time in the past (the sample predates a reset) is not a window either
      expect(sampleAt({ seven_day: { utilization: 20, resets_at: "2026-10-14T03:00:00Z" } }, "2026-10-15T03:00:00Z")).toMatchObject({
        state: "unknown",
        factor: 1,
      });
      run("--from-file", path.join(tmpDir, "missing.json"), "--now", "2026-10-15T03:00:00Z");
      expect(latest()).toMatchObject({ status: "unavailable", pace: { state: "unknown", factor: 1 } });
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
