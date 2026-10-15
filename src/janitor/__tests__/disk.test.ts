import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanerCommands, expireDirectories, loadJanitorConfig } from "../disk";
import { DEFAULT_JANITOR_CONFIG } from "../processes";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-disk-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const now = new Date("2026-10-06T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

/** <base>/<host>/<owner>/<repo>/pr-N, the layout of the review skill's worktree cache. */
function worktree(name: string, ageDays: number): string {
  const dir = path.join(
    root,
    "worktrees",
    "github.com",
    "groupon",
    "echelon",
    name,
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "file.ts"), "x");
  for (const target of [
    path.join(dir, "src", "file.ts"),
    path.join(dir, "src"),
    dir,
  ])
    fs.utimesSync(target, daysAgo(ageDays), daysAgo(ageDays));
  return dir;
}

describe("expiring old cache directories", () => {
  it("removes only directories at the configured depth that nothing touched within the age limit", () => {
    const old = worktree("pr-100", 12);
    const recent = worktree("pr-415", 2);
    const rule = {
      path: path.join(root, "worktrees"),
      depth: 4,
      maxAgeDays: 7,
    };

    const dry = expireDirectories(rule, now, false);
    expect(dry.map((entry) => path.basename(entry.path))).toEqual(["pr-100"]);
    expect(dry[0]).toMatchObject({ removed: false });
    expect(dry[0].ageDays).toBeCloseTo(12, 1);
    expect(fs.existsSync(old)).toBe(true);

    const applied = expireDirectories(rule, now, true);
    expect(
      applied.map((entry) => [path.basename(entry.path), entry.removed]),
    ).toEqual([["pr-100", true]]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    // The parents stay: only the directories at that depth are entries.
    expect(
      fs.existsSync(
        path.join(root, "worktrees", "github.com", "groupon", "echelon"),
      ),
    ).toBe(true);
  });

  it("keeps a directory whose own timestamp is old but which has a recently touched entry", () => {
    const dir = worktree("pr-200", 30);
    fs.writeFileSync(path.join(dir, "FETCH_HEAD"), "x");
    fs.utimesSync(dir, daysAgo(30), daysAgo(30));
    const rule = {
      path: path.join(root, "worktrees"),
      depth: 4,
      maxAgeDays: 7,
    };
    expect(expireDirectories(rule, now, true)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("does nothing for a missing base directory", () => {
    expect(
      expireDirectories(
        { path: path.join(root, "nope"), depth: 2, maxAgeDays: 1 },
        now,
        true,
      ),
    ).toEqual([]);
  });
});

describe("cache cleaners", () => {
  it("runs only the cleaners that are enabled and whose tool is installed", () => {
    const has = (binary: string) => binary !== "pnpm";
    const commands = cleanerCommands(
      DEFAULT_JANITOR_CONFIG.disk,
      has,
      () => true,
    );
    expect(commands.map((entry) => entry.argv.join(" "))).toEqual([
      "uv cache prune",
      "npm cache verify",
      "docker image prune -f",
      "docker builder prune -f --filter until=168h",
    ]);
    // Docker installed but not running: its cleaners would only fail.
    const dockerDown = cleanerCommands(
      DEFAULT_JANITOR_CONFIG.disk,
      () => true,
      () => false,
    );
    expect(dockerDown.map((entry) => entry.id)).toEqual(["uv", "pnpm", "npm"]);
    const none = cleanerCommands(
      {
        ...DEFAULT_JANITOR_CONFIG.disk,
        uvCachePrune: false,
        pnpmStorePrune: false,
        npmCacheVerify: false,
        dockerPrune: false,
      },
      () => true,
      () => true,
    );
    expect(none).toEqual([]);
  });
});

describe("janitor.yaml", () => {
  it("falls back to the defaults when there is no file", () => {
    expect(loadJanitorConfig(path.join(root, "janitor.yaml"))).toEqual(
      DEFAULT_JANITOR_CONFIG,
    );
  });

  it("merges a partial file over the defaults and expands ~ in paths", () => {
    const file = path.join(root, "janitor.yaml");
    fs.writeFileSync(
      file,
      [
        "min_age_minutes: 240",
        "protect:",
        "  ports: [3001, 3847]",
        "  directories: ['~/Programming/always-on']",
        "disk:",
        "  docker_prune: false",
        "  expire:",
        "    - path: ~/.claude/cache/pr-review-worktrees",
        "      depth: 4",
        "      max_age_days: 3",
      ].join("\n"),
    );
    const config = loadJanitorConfig(file);
    expect(config.minAgeMinutes).toBe(240);
    expect(config.maxCpuSecondsPerHour).toBe(
      DEFAULT_JANITOR_CONFIG.maxCpuSecondsPerHour,
    );
    expect(config.protect.ports).toEqual([3001, 3847]);
    expect(config.protect.directories).toEqual([
      path.join(os.homedir(), "Programming/always-on"),
    ]);
    // The built-in protections are added to, never replaced.
    expect(config.protect.commands).toEqual(
      DEFAULT_JANITOR_CONFIG.protect.commands,
    );
    expect(config.disk.dockerPrune).toBe(false);
    expect(config.disk.uvCachePrune).toBe(true);
    expect(config.disk.expire).toEqual([
      {
        path: path.join(os.homedir(), ".claude/cache/pr-review-worktrees"),
        depth: 4,
        maxAgeDays: 3,
      },
    ]);
  });

  it("rejects a file it cannot understand instead of guessing", () => {
    const file = path.join(root, "janitor.yaml");
    fs.writeFileSync(file, "min_age_minutes: soon\n");
    expect(() => loadJanitorConfig(file)).toThrow(/min_age_minutes/);
  });
});
