import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import { localHostName } from "../config";

const scutil = vi.mocked(execFileSync);
const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p });

describe("localHostName", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SCHEDULER_HOST", "");
    scutil.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setPlatform(realPlatform);
  });

  it("uses the Mac's LocalHostName when the network-derived hostname changes (2026-10-15 reboot: 'Mac')", () => {
    setPlatform("darwin");
    vi.spyOn(os, "hostname").mockReturnValue("Mac");
    scutil.mockReturnValue("D6H4HDF0Y4\n");
    expect(localHostName()).toBe("D6H4HDF0Y4");
    expect(scutil).toHaveBeenCalledWith("/usr/sbin/scutil", ["--get", "LocalHostName"], expect.anything());
  });

  it("AI_SCHEDULER_HOST still wins over everything", () => {
    setPlatform("darwin");
    vi.stubEnv("AI_SCHEDULER_HOST", "FL2R12XFMX");
    scutil.mockReturnValue("D6H4HDF0Y4\n");
    expect(localHostName()).toBe("FL2R12XFMX");
  });

  it("falls back to os.hostname() without .local when scutil fails or prints nothing", () => {
    setPlatform("darwin");
    vi.spyOn(os, "hostname").mockReturnValue("D6H4HDF0Y4.local");
    scutil.mockImplementation(() => {
      throw new Error("scutil: no such key");
    });
    expect(localHostName()).toBe("D6H4HDF0Y4");
    scutil.mockReturnValue("\n");
    expect(localHostName()).toBe("D6H4HDF0Y4");
  });

  it("never asks scutil off macOS", () => {
    setPlatform("linux");
    vi.spyOn(os, "hostname").mockReturnValue("ci-runner");
    expect(localHostName()).toBe("ci-runner");
    expect(scutil).not.toHaveBeenCalled();
  });
});
