import { CronExpressionParser } from "cron-parser";

export interface DetectMissedRunArgs {
  schedule: string;
  lastStartedAt: string | null;
  now: Date;
  isActive: boolean;
}

const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function detectMissedRun(args: DetectMissedRunArgs): Date | null {
  if (args.isActive) return null;

  let prev: Date;
  try {
    // Use now - TOLERANCE as reference so slots that fired within the tolerance
    // window are not treated as missed (e.g. job started 2 min after the slot).
    const refDate = new Date(args.now.getTime() - TOLERANCE_MS);
    const parser = CronExpressionParser.parse(args.schedule, { currentDate: refDate });
    prev = parser.prev().toDate();
  } catch {
    return null;
  }

  const nowMs = args.now.getTime();
  if (nowMs - prev.getTime() > MAX_LOOKBACK_MS) return null;

  const lastMs = args.lastStartedAt ? new Date(args.lastStartedAt).getTime() : 0;
  if (prev.getTime() <= lastMs + TOLERANCE_MS) return null;

  return prev;
}
