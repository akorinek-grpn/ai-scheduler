/**
 * List prices per million tokens for the Claude models the jobs use, so a script run's inner
 * Claude sessions (autopilot's stage 2 and babysit sessions) can be costed from their transcripts
 * (daemon/inner-sessions.ts): a transcript carries each API call's token usage and model but no
 * dollar amount, while `claude -p` prints `total_cost_usd` only to the process that started it.
 *
 * Source: the model catalog bundled in the claude CLI (2.1.301, read 2026-10-16), the same table
 * Claude Code prices its own sessions with. Prices are USD per million tokens; cache writes are
 * priced by their TTL (5 min or 1 h), as the API reports them. An id that is not listed (a new
 * release, a `-fast` variant, a provider-prefixed id) is not guessed: priceUsage returns null and
 * the tokens still count. On a model launch add one row here.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Prices above a prompt-size threshold (input + cache tokens of one call). */
  longPrompt?: { abovePromptTokens: number } & Omit<ModelPrice, "longPrompt">;
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cache writes whose TTL the API did not report; priced at the 5-minute rate. */
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
}

const tier = (
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
): ModelPrice => ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });

const TIER_2_10 = tier(2, 10, 2.5, 4, 0.2);
const TIER_2_10_CACHE_READ_0_10 = tier(2, 10, 2.5, 4, 0.1);
const TIER_3_15 = tier(3, 15, 3.75, 6, 0.3);
const TIER_4_20_CACHE_READ_0_20 = tier(4, 20, 5, 8, 0.2);
const TIER_5_25 = tier(5, 25, 6.25, 10, 0.5);
const TIER_10_50 = tier(10, 50, 12.5, 20, 1);
const TIER_10_50_CACHE_READ_0_25 = tier(10, 50, 12.5, 20, 0.25);
const TIER_15_75 = tier(15, 75, 18.75, 30, 1.5);
const HAIKU_35 = tier(0.8, 4, 1, 1.6, 0.08);
const HAIKU_45 = tier(1, 5, 1.25, 2, 0.1);
const HAIKU_55: ModelPrice = {
  ...tier(0.1, 0.5, 0.125, 0.2, 0.01),
  longPrompt: { abovePromptTokens: 100_000, ...tier(0.5, 2.5, 0.625, 1, 0.05) },
};

/** Model id prefix (dated and undated ids share it) -> price. Longest matching prefix wins. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-3-5-haiku": HAIKU_35,
  "claude-haiku-4-5": HAIKU_45,
  "claude-haiku-5-5": HAIKU_55,
  "claude-3-5-sonnet": TIER_3_15,
  "claude-3-7-sonnet": TIER_3_15,
  "claude-sonnet-4-0": TIER_3_15,
  "claude-sonnet-4-5": TIER_3_15,
  "claude-sonnet-4-6": TIER_3_15,
  "claude-sonnet-5": TIER_2_10,
  "claude-sonnet-5-5": TIER_2_10_CACHE_READ_0_10,
  "claude-opus-4-0": TIER_15_75,
  "claude-opus-4-1": TIER_15_75,
  "claude-opus-4-5": TIER_5_25,
  "claude-opus-4-6": TIER_5_25,
  "claude-opus-4-7": TIER_5_25,
  "claude-opus-4-8": TIER_5_25,
  "claude-opus-5": TIER_5_25,
  "claude-opus-5-5": TIER_4_20_CACHE_READ_0_20,
  "claude-fable-5": TIER_10_50,
  "claude-fable-5-1": TIER_10_50_CACHE_READ_0_25,
  "claude-mythos-5": TIER_10_50,
  "claude-mythos-5-1": TIER_10_50_CACHE_READ_0_25,
};

const DATE_SUFFIX = /-20\d{6}$/;

/** The price row for a first-party model id, or null when it is not listed (never guessed). */
export function findModelPrice(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase().replace(DATE_SUFFIX, "");
  if (!id.startsWith("claude-") || id.endsWith("-fast")) return null;
  let best: string | null = null;
  for (const prefix of Object.keys(MODEL_PRICES)) {
    // "claude-opus-5" must not price "claude-opus-5-5": a prefix matches the id itself or a
    // dated/variant suffix that starts with a letter group, never a further version number.
    if (id !== prefix && !(id.startsWith(`${prefix}-`) && !/^\d/.test(id.slice(prefix.length + 1))))
      continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best === null ? null : MODEL_PRICES[best];
}

/** USD for one API call's usage at the model's list price, or null when the model is unlisted. */
export function priceUsage(model: string, usage: CallUsage): number | null {
  const listed = findModelPrice(model);
  if (!listed) return null;
  const promptTokens =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + (usage.cacheWrite1hTokens ?? 0);
  const price =
    listed.longPrompt && promptTokens > listed.longPrompt.abovePromptTokens ? listed.longPrompt : listed;
  const perMillion =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite5m +
    (usage.cacheWrite1hTokens ?? 0) * price.cacheWrite1h;
  return perMillion / 1_000_000;
}
