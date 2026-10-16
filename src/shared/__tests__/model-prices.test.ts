import { describe, it, expect } from "vitest";
import { findModelPrice, priceUsage, MODEL_PRICES } from "../model-prices";

describe("findModelPrice", () => {
  it("prices a dated id by its undated row and keeps minor versions apart", () => {
    expect(findModelPrice("claude-opus-5-5-20260301")).toBe(MODEL_PRICES["claude-opus-5-5"]);
    expect(findModelPrice("claude-opus-5")).toBe(MODEL_PRICES["claude-opus-5"]);
    // "claude-opus-5" is a prefix of "claude-opus-5-5", but Opus 5.5 has its own row.
    expect(findModelPrice("claude-opus-5-5")).not.toBe(MODEL_PRICES["claude-opus-5"]);
    expect(findModelPrice("claude-sonnet-5-5")).toBe(MODEL_PRICES["claude-sonnet-5-5"]);
    expect(findModelPrice("Claude-Haiku-5-5")).toBe(MODEL_PRICES["claude-haiku-5-5"]);
  });

  it("never guesses: fast variants, provider-prefixed ids and unknown releases are null", () => {
    expect(findModelPrice("claude-sonnet-5-5-fast")).toBeNull();
    expect(findModelPrice("us.anthropic.claude-sonnet-5-5")).toBeNull();
    expect(findModelPrice("claude-opus-6")).toBeNull();
    expect(findModelPrice("gpt-6.1-sol")).toBeNull();
  });
});

describe("priceUsage", () => {
  it("prices input, output, cache reads and both cache-write TTLs at the row's rates", () => {
    // Opus 5.5: 4 / 20 / 5 (5 min) / 8 (1 h) / 0.2 per million tokens.
    expect(
      priceUsage("claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      }),
    ).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 9);
  });

  it("switches Haiku 5.5 to its long-prompt rates above 100k prompt tokens", () => {
    const short = priceUsage("claude-haiku-5-5", {
      inputTokens: 90_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const long = priceUsage("claude-haiku-5-5", {
      inputTokens: 110_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(short).toBeCloseTo((90_000 * 0.1 + 1_000 * 0.5) / 1e6, 9);
    expect(long).toBeCloseTo((110_000 * 0.5 + 1_000 * 2.5) / 1e6, 9);
  });

  it("returns null for an unlisted model", () => {
    expect(priceUsage("claude-opus-9", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});
