import type http from "http";

/**
 * The port is already held by another daemon instance.
 *
 * This is the only single-instance signal worth trusting: data/daemon.json can
 * hold a stale PID, and a second daemon overwrites it with its own, so the file
 * says nothing about who is actually serving. The OS refusing the bind does.
 */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is already in use`);
    this.name = "PortInUseError";
  }
}

/**
 * Bind the port, rejecting rather than leaving the process half-alive.
 *
 * Call this BEFORE scheduling any jobs. A second daemon that loses the bind but
 * keeps running still registers every cron task, and because each process has
 * its own in-memory "job already active" guard, neither sees the other - every
 * job then runs twice (observed: ~20h of doubled runs, doubled API spend, and
 * PR review comments posted twice).
 */
export function listenExclusive(
  server: http.Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(err.code === "EADDRINUSE" ? new PortInUseError(port) : err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
