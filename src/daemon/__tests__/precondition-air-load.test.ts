import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/precondition-air-load.sh against fake macOS tools on PATH: every signal the
 * script reads (lock-status.sh, memory_pressure, sysctl, pmset, pgrep) is a shim, so the
 * tests pin the exit code and the printed reason for each guardrail without a real Air.
 */
const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "precondition-air-load.sh");

interface Machine {
  lock?: string;
  freePct?: number;
  pressureLevel?: number;
  swapUsed?: string;
  load5?: number;
  cores?: number;
  cpuSpeed?: number | null;
  busy?: string;
}

function shim(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(machine: Machine, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "air-load-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const {
    lock = "FREE (no lock)",
    freePct = 50,
    pressureLevel = 1,
    swapUsed = "517.38M",
    load5 = 4,
    cores = 8,
    cpuSpeed = null,
    busy = "",
  } = machine;
  shim(bin, "lock-status.sh", `echo "${lock}"`);
  shim(bin, "memory_pressure", `echo "System-wide memory free percentage: ${freePct}%"`);
  shim(
    bin,
    "sysctl",
    [
      `case "$2" in`,
      `  kern.memorystatus_vm_pressure_level) echo ${pressureLevel} ;;`,
      `  vm.swapusage) echo "total = 2048.00M  used = ${swapUsed}  free = 1530.62M  (encrypted)" ;;`,
      `  vm.loadavg) echo "{ 3.10 ${load5.toFixed(2)} 2.90 }" ;;`,
      `  hw.logicalcpu) echo ${cores} ;;`,
      `esac`,
    ].join("\n"),
  );
  shim(
    bin,
    "pmset",
    cpuSpeed === null
      ? `echo "Note: No thermal warning level has been recorded"`
      : `echo "CPU_Scheduler_Limit = 100"; echo "CPU_Speed_Limit = ${cpuSpeed}"`,
  );
  shim(bin, "pgrep", busy ? `echo "${busy}"` : "exit 1");
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AUTOPILOT_LOCK_STATUS: join(bin, "lock-status.sh"),
    },
  });
  return { code: result.status, out: result.stdout };
}

describe("precondition-air-load.sh", () => {
  it("exits 0 on a free Air and prints every signal it read", () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain("autopilot lock: FREE");
    expect(r.out).toContain("memory: 50% free");
    expect(r.out).toContain("memory pressure: normal");
    expect(r.out).toContain("swap: 517 MB used");
    expect(r.out).toContain("load: 5-min average 4.00 on 8 cores = 0.50 per core");
    expect(r.out).toContain("thermal: no throttling recorded");
    expect(r.out).toContain("load: no build or test running");
  });

  it("defers (75) while the autopilot lock is held", () => {
    const r = run({ lock: "HELD by autopilot-daily run 97" });
    expect(r.code).toBe(75);
    expect(r.out).toContain("autopilot lock: HELD");
  });

  it("defers below the free-memory floor", () => {
    expect(run({ freePct: 12 }).code).toBe(75);
    expect(run({ freePct: 20 }).code).toBe(0);
  });

  it("defers on kernel memory pressure warn or critical", () => {
    const warn = run({ pressureLevel: 2 });
    expect(warn.code).toBe(75);
    expect(warn.out).toContain("memory pressure: level 2");
    expect(run({ pressureLevel: 4 }).code).toBe(75);
  });

  it("defers when swap in use is above the cap, in M or G units", () => {
    const r = run({ swapUsed: "5.20G" });
    expect(r.code).toBe(75);
    expect(r.out).toContain("swap: 5324 MB used (cap 4096 MB)");
    expect(run({ swapUsed: "4000.00M" }).code).toBe(0);
    expect(run({ swapUsed: "5.20G" }, { AUTOPILOT_MAX_SWAP_MB: "8192" }).code).toBe(0);
  });

  it("defers when the 5-minute load is above the per-core cap (2.0 x cores by default)", () => {
    const busyAir = run({ load5: 16.5, cores: 8 });
    expect(busyAir.code).toBe(75);
    expect(busyAir.out).toContain("= 2.06 per core (cap 2.0)");
    // 2026-10-16 14:5xZ reading: 15.59 on 8 cores during a review round with Chrome open.
    expect(run({ load5: 15.59, cores: 8 }).code).toBe(0);
    expect(run({ load5: 15.59, cores: 8 }, { AUTOPILOT_MAX_LOAD_PER_CORE: "1.5" }).code).toBe(75);
  });

  it("defers on recorded CPU throttling below the floor and ignores a missing reading", () => {
    const throttled = run({ cpuSpeed: 55 });
    expect(throttled.code).toBe(75);
    expect(throttled.out).toContain("thermal: CPU speed limit 55% (floor 70%)");
    expect(run({ cpuSpeed: 100 }).code).toBe(0);
    expect(run({ cpuSpeed: null }).code).toBe(0);
  });

  it("defers while another job's build or test runs", () => {
    const r = run({ busy: "41234 node /x/node_modules/.bin/vitest run" });
    expect(r.code).toBe(75);
    expect(r.out).toContain("build/test still running:");
  });

  it("keeps only the lock check with AUTOPILOT_SKIP_LOAD_CHECK=1", () => {
    const r = run({ load5: 40, pressureLevel: 4 }, { AUTOPILOT_SKIP_LOAD_CHECK: "1" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("memory pressure");
  });
});
