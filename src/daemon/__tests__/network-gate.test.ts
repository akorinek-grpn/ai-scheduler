import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { canConnect, waitForNetwork } from "../network-gate";

describe("waitForNetwork", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves true at once, without logging, when the network is up", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    await expect(waitForNetwork({ probe })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("probes every intervalMs until the network is back", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const result = waitForNetwork({ probe, intervalMs: 15_000 });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/network unreachable/i),
    );
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringMatching(/network is back after 30 s/i),
    );
  });

  it("gives up after maxWaitMs and resolves false, so the catch-up still runs and fails visibly", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const result = waitForNetwork({
      probe,
      intervalMs: 15_000,
      maxWaitMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(5); // at 0, 15, 30, 45 and 60 s
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringMatching(/still unreachable after 1 min/i),
    );
  });
});

describe("canConnect", () => {
  it("is true when something accepts the connection", async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(canConnect("127.0.0.1", port)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  it("is false when nothing listens on the port", async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((r) => server.close(r));
    await expect(canConnect("127.0.0.1", port)).resolves.toBe(false);
  });

  it("is false when the host name does not resolve (the ENOTFOUND of 2026-08-13)", async () => {
    // .invalid never resolves (RFC 2606), online or not.
    await expect(canConnect("scheduler-probe.invalid", 443)).resolves.toBe(
      false,
    );
  });
});
