import { describe, expect, it, vi } from "vitest";
import { calculateCost } from "../src/cost-calculator.ts";
import type { UsageEntry } from "../src/log-parser.ts";
import type { ModelPricing } from "../src/pricing.ts";

function createEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    timestamp: new Date("2026-02-11T00:00:00.000Z"),
    model: "claude-sonnet-4-5-20250929",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 2000,
    cacheReadTokens: 3000,
    messageId: "m1",
    requestId: "r1",
    costUSD: null,
    ...overrides,
  };
}

function createPricing(getPrice: ModelPricing["getPrice"]): ModelPricing {
  return { getPrice };
}

describe("calculateCost", () => {
  it("returns costUSD in display mode", () => {
    const pricing = createPricing(() => null);
    expect(calculateCost(createEntry({ costUSD: 1.23 }), "display", pricing)).toBe(1.23);
    expect(calculateCost(createEntry({ costUSD: null }), "display", pricing)).toBe(0);
  });

  it("returns costUSD in auto mode when available without pricing lookup", () => {
    const getPrice = vi.fn(() => ({
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheCreatePerMTok: 1,
      cacheReadPerMTok: 1,
    }));
    const pricing = createPricing(getPrice);

    expect(calculateCost(createEntry({ costUSD: 9.99 }), "auto", pricing)).toBe(9.99);
    expect(getPrice).not.toHaveBeenCalled();
  });

  it("calculates from tokens when mode is calculate", () => {
    const pricing = createPricing(() => ({
      inputPerMTok: 2,
      outputPerMTok: 4,
      cacheCreatePerMTok: 6,
      cacheReadPerMTok: 8,
    }));
    const entry = createEntry({
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheCreationTokens: 3_000_000,
      cacheReadTokens: 4_000_000,
    });

    const cost = calculateCost(entry, "calculate", pricing);
    expect(cost).toBe(2 + 8 + 18 + 32);
  });

  it("returns 0 when pricing is unavailable", () => {
    const pricing = createPricing(() => null);
    expect(calculateCost(createEntry(), "calculate", pricing)).toBe(0);
  });
});
