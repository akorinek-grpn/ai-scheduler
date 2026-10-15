import { describe, expect, it } from "vitest";
import {
  DEFAULT_JANITOR_CONFIG,
  parseCpuTime,
  parseElapsed,
  parsePs,
  planUnits,
  unitKey,
  type JanitorState,
  type ProcessInfo,
  type Snapshot,
} from "../processes";

const ROOT = "/Users/me/Programming/ai-scheduler";
const STARTED = "Mon Oct  5 09:00:00 2026";
const HOURS = 3600;

const proc = (
  pid: number,
  ppid: number,
  command: string,
  extra: Partial<ProcessInfo> = {},
): ProcessInfo => ({
  pid,
  ppid,
  pgid: pid,
  uid: 502,
  elapsedSeconds: 6 * HOURS,
  cpuSeconds: 100,
  rssKb: 1024,
  command,
  startedAt: STARTED,
  ...extra,
});

const snapshot = (
  processes: ProcessInfo[],
  extra: Partial<Snapshot> = {},
): Snapshot => ({
  now: new Date("2026-10-06T12:00:00Z"),
  uid: 502,
  processes: [proc(1, 0, "/sbin/launchd", { uid: 0 }), ...processes],
  listening: new Map(),
  launchdManaged: new Set(),
  cwd: new Map(),
  footprintMb: new Map(),
  daemonPid: null,
  projectRoot: ROOT,
  ...extra,
});

/** A previous observation two hours earlier, where each listed unit had the given CPU total. */
const seen = (units: Record<string, number>): JanitorState => ({
  observedAt: "2026-10-06T10:00:00Z",
  units: Object.fromEntries(
    Object.entries(units).map(([key, cpuSeconds]) => [key, { cpuSeconds }]),
  ),
});

// An agent started `npm run dev` for a preview and its session ended: the tree hangs off launchd.
const orphanedDevServer = (cpu = 100): ProcessInfo[] => [
  proc(200, 1, "npm run dev", { cpuSeconds: 1 }),
  proc(
    201,
    200,
    "node /Users/me/Programming/hub-tools/preview/node_modules/.bin/next dev -p 3001",
    { cpuSeconds: 2 },
  ),
  proc(202, 201, "next-server (v15.5.18)", { cpuSeconds: cpu - 3 }),
];
const devKey = unitKey(200, STARTED);

describe("ps parsing", () => {
  it("reads elapsed and CPU times in every format ps prints", () => {
    expect(parseElapsed("02:39")).toBe(159);
    expect(parseElapsed("04:31:13")).toBe(4 * 3600 + 31 * 60 + 13);
    expect(parseElapsed("03-03:24:29")).toBe(
      3 * 86400 + 3 * 3600 + 24 * 60 + 29,
    );
    expect(parseCpuTime("0:01.23")).toBeCloseTo(1.23, 5);
    expect(parseCpuTime("91:40.84")).toBeCloseTo(91 * 60 + 40.84, 5);
    expect(parseCpuTime("2:37:49")).toBe(2 * 3600 + 37 * 60 + 49);
  });

  it("parses ps rows and keeps the whole command line", () => {
    const rows = parsePs(
      [
        "  200     1   200   502    04:49:55   3:09.13  40960 npm run dev   ",
        "  201   200   200   502 03-03:24:29   0:02.00   8192 node /path with space/next dev -p 3001",
        "garbage line",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pid: 200,
      ppid: 1,
      pgid: 200,
      uid: 502,
      rssKb: 40960,
      command: "npm run dev",
    });
    expect(rows[1].command).toBe("node /path with space/next dev -p 3001");
    expect(rows[1].elapsedSeconds).toBe(3 * 86400 + 3 * 3600 + 24 * 60 + 29);
  });
});

describe("which process trees the janitor may stop", () => {
  it("stops a dev server whose session is gone once it is old, seen before and idle", () => {
    const units = planUnits(
      snapshot(orphanedDevServer(), {
        listening: new Map([[202, [3001]]]),
        footprintMb: new Map([
          [200, 40],
          [201, 60],
          [202, 4792],
        ]),
        cwd: new Map([[200, "/Users/me/Programming/hub-tools/preview"]]),
      }),
      DEFAULT_JANITOR_CONFIG,
      seen({ [devKey]: 95 }),
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      rootPid: 200,
      kind: "dev-server",
      verdict: "stop",
      ports: [3001],
      footprintMb: 4892,
      cwd: "/Users/me/Programming/hub-tools/preview",
    });
    // Leaves first, so a parent cannot respawn a child that was just stopped.
    expect(units[0].pids).toEqual([202, 201, 200]);
    expect(units[0].cpuRatePerHour).toBeCloseTo(2.5, 5);
  });

  it("leaves a dev server alone while its terminal is still open", () => {
    const attached = [
      proc(920, 1, "/Applications/Warp.app/Contents/MacOS/stable"),
      proc(1259, 920, "-zsh -g --no_rcs"),
      proc(300, 1259, "bun run dev"),
      proc(
        301,
        300,
        "node /Users/me/Programming/personalized-helper/node_modules/.bin/next dev -p 3847",
      ),
    ];
    expect(
      planUnits(snapshot(attached), DEFAULT_JANITOR_CONFIG, seen({})),
    ).toEqual([]);
  });

  it("only observes on first sight, and never stops a tree that is young or still working", () => {
    const first = planUnits(
      snapshot(orphanedDevServer()),
      DEFAULT_JANITOR_CONFIG,
      null,
    );
    expect(first[0]).toMatchObject({
      verdict: "observe",
      cpuRatePerHour: null,
    });

    const young = orphanedDevServer().map((p) => ({
      ...p,
      elapsedSeconds: 30 * 60,
    }));
    expect(
      planUnits(
        snapshot(young),
        DEFAULT_JANITOR_CONFIG,
        seen({ [devKey]: 95 }),
      )[0].verdict,
    ).toBe("young");

    // 100 CPU-seconds now against 10 two hours ago: 45 s/hour is fine, 400 s/hour is a server in use.
    const busy = planUnits(
      snapshot(orphanedDevServer(900)),
      DEFAULT_JANITOR_CONFIG,
      seen({ [devKey]: 100 }),
    );
    expect(busy[0]).toMatchObject({ verdict: "busy" });
    expect(busy[0].cpuRatePerHour).toBeCloseTo(400, 5);

    // A previous sample taken minutes ago says nothing about idleness yet.
    const tooSoon: JanitorState = {
      observedAt: "2026-10-06T11:55:00Z",
      units: { [devKey]: { cpuSeconds: 100 } },
    };
    expect(
      planUnits(
        snapshot(orphanedDevServer()),
        DEFAULT_JANITOR_CONFIG,
        tooSoon,
      )[0].verdict,
    ).toBe("observe");

    // CPU total went down: a child was replaced, so the tree is doing something.
    const restarted = planUnits(
      snapshot(orphanedDevServer(50)),
      DEFAULT_JANITOR_CONFIG,
      seen({ [devKey]: 100 }),
    );
    expect(restarted[0].verdict).toBe("busy");
  });

  it("never touches the scheduler: the daemon, the jobs it runs, or anything from this project", () => {
    // Started with scripts/start-daemon.sh (nohup), so the daemon itself hangs off launchd.
    const daemon = [
      proc(400, 1, `node ${ROOT}/node_modules/.bin/tsx src/daemon/index.ts`),
      proc(
        401,
        400,
        `/usr/local/bin/node --require ${ROOT}/node_modules/tsx/dist/preflight.cjs src/daemon/index.ts`,
      ),
      // A script job the daemon is running right now, which happens to start a dev server.
      proc(402, 401, "/bin/sh -c bun run dev"),
      proc(
        403,
        402,
        "node /Users/me/Programming/other/node_modules/.bin/next dev",
      ),
    ];
    const byPid = planUnits(
      snapshot(daemon, { daemonPid: 401 }),
      DEFAULT_JANITOR_CONFIG,
      seen({ [unitKey(400, STARTED)]: 100 }),
    );
    expect(byPid).toHaveLength(1);
    expect(byPid[0]).toMatchObject({ verdict: "protected" });
    expect(byPid[0].reason).toMatch(/scheduler/i);

    // The web UI started in the background from this checkout, with no daemon.json to go by.
    const webUi = [
      proc(
        410,
        1,
        `node ${ROOT}/node_modules/.bin/next dev src/web --port 3500`,
      ),
    ];
    const byPath = planUnits(
      snapshot(webUi),
      DEFAULT_JANITOR_CONFIG,
      seen({ [unitKey(410, STARTED)]: 100 }),
    );
    expect(byPath[0]).toMatchObject({ verdict: "protected" });

    // Same, recognised by its working directory when the command line is relative.
    const relative = [
      proc(420, 1, "node node_modules/.bin/next dev src/web --port 3500"),
    ];
    const byCwd = planUnits(
      snapshot(relative, { cwd: new Map([[420, ROOT]]) }),
      DEFAULT_JANITOR_CONFIG,
      seen({ [unitKey(420, STARTED)]: 100 }),
    );
    expect(byCwd[0]).toMatchObject({ verdict: "protected" });
  });

  it("does not protect MCP servers a finished scheduler job left behind in this project's directory", () => {
    // Scheduled Claude jobs run with the project as their working directory; when one ends and an
    // MCP server survives it, the orphan inherits that directory but belongs to nobody.
    const leftover = [
      proc(
        450,
        1,
        "/Users/me/.cache/uv/archive-v0/abc/bin/python /Users/me/.cache/uv/archive-v0/abc/bin/mcp-atlassian",
      ),
    ];
    const units = planUnits(
      snapshot(leftover, { cwd: new Map([[450, ROOT]]), daemonPid: 401 }),
      DEFAULT_JANITOR_CONFIG,
      seen({ [unitKey(450, STARTED)]: 100 }),
    );
    expect(units[0]).toMatchObject({ kind: "mcp-server", verdict: "stop" });
  });

  it("does not report a Claude job that outlived a daemon restart, or its MCP servers", () => {
    const job = [
      proc(
        500,
        1,
        "claude -p --verbose --output-format stream-json --model sonnet",
      ),
      proc(501, 500, "npm exec @upstash/context7-mcp@4.0.6"),
      proc(
        502,
        501,
        "node /Users/me/.npm/_npx/5f86/node_modules/.bin/context7-mcp",
      ),
      proc(503, 500, "/opt/homebrew/bin/uv tool uvx mcp-atlassian"),
    ];
    expect(planUnits(snapshot(job), DEFAULT_JANITOR_CONFIG, seen({}))).toEqual(
      [],
    );
  });

  it("stops MCP servers left behind after their Claude session ended", () => {
    const orphans = [
      proc(600, 1, "npm exec @upstash/context7-mcp@4.0.6"),
      proc(
        601,
        600,
        "node /Users/me/.npm/_npx/5f86/node_modules/.bin/context7-mcp",
      ),
      proc(610, 1, "/opt/homebrew/bin/uv tool uvx mcp-atlassian"),
      proc(620, 1, "node /Users/me/.pilot/bin/codegraph serve --mcp"),
    ];
    const units = planUnits(
      snapshot(orphans),
      DEFAULT_JANITOR_CONFIG,
      seen({
        [unitKey(600, STARTED)]: 200,
        [unitKey(610, STARTED)]: 100,
        [unitKey(620, STARTED)]: 100,
      }),
    );
    expect(
      units.map((unit) => [unit.rootPid, unit.kind, unit.verdict]),
    ).toEqual([
      [600, "mcp-server", "stop"],
      [610, "mcp-server", "stop"],
      [620, "mcp-server", "stop"],
    ]);
  });

  it("protects launchd services, the default long-lived workers, and whatever the protect list names", () => {
    const state = seen({
      [unitKey(700, STARTED)]: 100,
      [unitKey(710, STARTED)]: 100,
      [unitKey(720, STARTED)]: 100,
      [unitKey(730, STARTED)]: 100,
      [unitKey(740, STARTED)]: 100,
    });
    const processes = [
      // A dev server someone runs as a LaunchAgent on purpose.
      proc(700, 1, "node /Users/me/site/node_modules/.bin/vite --port 5173"),
      // Pilot's memory worker daemonises itself and keeps an MCP child.
      proc(
        710,
        1,
        "/Users/me/.bun/bin/bun /Users/me/.pilot/scripts/worker-service.cjs --daemon",
      ),
      proc(711, 710, "node /Users/me/.pilot/scripts/mcp-server.cjs"),
      proc(
        720,
        1,
        "node /Users/me/Programming/docs-site/node_modules/.bin/next dev -p 4000",
      ),
      proc(730, 1, "bun run dev"),
      proc(740, 1, "node /Users/me/tools/keep-me/node_modules/.bin/next dev"),
    ];
    const units = planUnits(
      snapshot(processes, {
        launchdManaged: new Set([700]),
        listening: new Map([[720, [4000]]]),
        cwd: new Map([[730, "/Users/me/Programming/always-on/app"]]),
      }),
      {
        ...DEFAULT_JANITOR_CONFIG,
        protect: {
          ...DEFAULT_JANITOR_CONFIG.protect,
          commands: [
            ...DEFAULT_JANITOR_CONFIG.protect.commands,
            "tools/keep-me/",
          ],
          ports: [4000],
          directories: ["/Users/me/Programming/always-on"],
        },
      },
      state,
    );
    expect(units.map((unit) => [unit.rootPid, unit.verdict])).toEqual([
      [700, "protected"],
      [710, "protected"],
      [720, "protected"],
      [730, "protected"],
      [740, "protected"],
    ]);
    expect(units[0].reason).toMatch(/launchd/);
    expect(units[1].reason).toMatch(/worker-service/);
    expect(units[2].reason).toMatch(/4000/);
    expect(units[3].reason).toMatch(/always-on/);
    expect(units[4].reason).toMatch(/keep-me/);
  });

  it("ignores other users' processes, unrelated orphans, and kinds switched off in the config", () => {
    const processes = [
      proc(800, 1, "npm run dev", { uid: 0 }),
      proc(801, 800, "next-server (v15.5.18)", { uid: 0 }),
      // Detached, old and idle, but neither a dev server nor an MCP server.
      proc(
        810,
        1,
        "/usr/local/bin/python3 /Users/me/scripts/long-training-run.py",
      ),
      proc(820, 1, "/opt/homebrew/bin/uv tool uvx mcp-atlassian"),
    ];
    const state = seen({
      [unitKey(820, STARTED)]: 100,
      [unitKey(810, STARTED)]: 100,
    });
    const all = planUnits(snapshot(processes), DEFAULT_JANITOR_CONFIG, state);
    expect(all.map((unit) => unit.rootPid)).toEqual([820]);
    const noMcp = planUnits(
      snapshot(processes),
      {
        ...DEFAULT_JANITOR_CONFIG,
        kill: { devServers: true, mcpServers: false },
      },
      state,
    );
    expect(noMcp).toEqual([]);
  });
});
