/**
 * The usage hold's record on disk, `data/usage-hold.json`, so a restarted daemon (a deploy's
 * drain, a crash) does not start the Claude jobs again before the account's reset. Small and
 * tolerant: a missing or damaged file means no hold.
 */
import fs from "fs";
import path from "path";
import { getDataDir } from "@shared/paths";
import type { UsageHold } from "@shared/types";

export function getUsageHoldPath(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), "usage-hold.json");
}

export function readUsageHold(projectRoot: string): UsageHold | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getUsageHoldPath(projectRoot), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UsageHold> & { version?: number };
    if (
      parsed.version !== 1 ||
      (parsed.kind !== "weekly" && parsed.kind !== "session") ||
      typeof parsed.until !== "string" ||
      !Number.isFinite(Date.parse(parsed.until)) ||
      typeof parsed.since !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      kind: parsed.kind,
      until: parsed.until,
      since: parsed.since,
      text: typeof parsed.text === "string" ? parsed.text : "",
      skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
      jobId: typeof parsed.jobId === "string" ? parsed.jobId : null,
      runId: typeof parsed.runId === "string" ? parsed.runId : null,
    };
  } catch {
    return null;
  }
}

export function writeUsageHold(projectRoot: string, hold: UsageHold): void {
  const file = getUsageHoldPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hold, null, 2));
}

export function removeUsageHold(projectRoot: string): void {
  try {
    fs.unlinkSync(getUsageHoldPath(projectRoot));
  } catch {
    // already gone
  }
}
