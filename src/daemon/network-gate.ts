import net from "node:net";

/**
 * What the catch-up queue probes before each catch-up: the Claude API, which every claude
 * job needs first. A TCP connect covers DNS and routing without TLS, so a corporate TLS
 * proxy cannot make a working network look down.
 */
export const NETWORK_PROBE = { host: "api.anthropic.com", port: 443 } as const;

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60_000;

/** True when a TCP connection to host:port opens within timeoutMs (name resolution included). */
export function canConnect(
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export interface WaitForNetworkOptions {
  /** Resolves true when the network is usable. */
  probe: () => Promise<boolean>;
  /** Pause between failed probes. Default 15 s. */
  intervalMs?: number;
  /** Stop waiting after this long; the caller goes ahead anyway. Default 10 min. */
  maxWaitMs?: number;
}

/**
 * Resolves true as soon as `probe` succeeds, or false once it has failed for maxWaitMs. The
 * catch-up queue waits on this after a wake (2026-08-13: three catch-ups started minutes after
 * waking and died on ENOTFOUND / "Unable to connect"). Giving up rather than waiting forever
 * lets a real outage end in a visible failed run, and never stalls the queue.
 */
export async function waitForNetwork(
  opts: WaitForNetworkOptions,
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = Date.now();
  let waiting = false;
  for (;;) {
    if (await opts.probe()) {
      if (waiting) {
        console.log(
          `[catchup] Network is back after ${Math.round((Date.now() - startedAt) / 1000)} s`,
        );
      }
      return true;
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      console.log(
        `[catchup] Network still unreachable after ${Math.round(maxWaitMs / 60_000)} min - starting the catch-up anyway`,
      );
      return false;
    }
    if (!waiting) {
      console.log(
        `[catchup] Network unreachable - waiting up to ${Math.round(maxWaitMs / 60_000)} min before the next catch-up`,
      );
      waiting = true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
