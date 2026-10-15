import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diskFree, readMachine, sizeGb, workingDirectories } from "../collect";

// The readers shell out to macOS tools; elsewhere they would only return "unknown".
describe.skipIf(process.platform !== "darwin")("reading the machine", () => {
  it("sees this process with its parent, start time and working directory", () => {
    const { snapshot } = readMachine("/tmp/not-a-project");
    const self = snapshot.processes.find((entry) => entry.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.uid).toBe(process.getuid?.());
    expect(self?.startedAt).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);
    expect(self?.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(
      snapshot.processes.some((entry) => entry.pid === 1 && entry.ppid === 0),
    ).toBe(true);
    expect(snapshot.uid).toBe(process.getuid?.());
    expect(snapshot.daemonPid).toBeNull();
    expect(snapshot.launchdManaged.size).toBeGreaterThan(0);
    expect(snapshot.launchdManaged.has(process.pid)).toBe(false);
    expect(
      fs.realpathSync(workingDirectories([process.pid]).get(process.pid) ?? ""),
    ).toBe(fs.realpathSync(process.cwd()));
  });

  it("measures free space and directory sizes", () => {
    const free = diskFree(os.homedir());
    expect(free?.totalGb).toBeGreaterThan(1);
    expect(free?.freeGb).toBeGreaterThan(0);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-size-"));
    try {
      fs.writeFileSync(
        path.join(directory, "blob"),
        Buffer.alloc(3 * 1024 * 1024),
      );
      const size = sizeGb([directory]);
      expect(size).toBeGreaterThan(0.002);
      expect(size).toBeLessThan(0.01);
      expect(sizeGb([path.join(directory, "missing")])).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
