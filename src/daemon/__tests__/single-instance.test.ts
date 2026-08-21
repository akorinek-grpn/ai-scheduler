import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { listenExclusive, PortInUseError } from "../single-instance";

const PORT = 3599; // not the real daemon port
const servers: http.Server[] = [];

function newServer(): http.Server {
  const s = http.createServer();
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((res) => (s.listening ? s.close(() => res()) : res())),
    ),
  );
});

describe("listenExclusive", () => {
  it("binds the port when it is free", async () => {
    const s = newServer();
    await listenExclusive(s, PORT, "127.0.0.1");
    expect(s.listening).toBe(true);
  });

  it("rejects with PortInUseError when another instance holds the port", async () => {
    // The bug this guards: a second daemon lost the bind but still registered
    // every cron schedule, so all 20 jobs ran twice for ~20h.
    const first = newServer();
    await listenExclusive(first, PORT, "127.0.0.1");

    const second = newServer();
    await expect(
      listenExclusive(second, PORT, "127.0.0.1"),
    ).rejects.toBeInstanceOf(PortInUseError);
  });

  it("propagates non-EADDRINUSE listen errors unchanged", async () => {
    const s = newServer();
    // Port 1 is privileged: EACCES for a non-root process, not EADDRINUSE.
    await expect(listenExclusive(s, 1, "127.0.0.1")).rejects.not.toBeInstanceOf(
      PortInUseError,
    );
  });
});
