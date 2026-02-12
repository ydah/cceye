import { describe, expect, it, vi } from "vitest";
import { aggregateByPeriod } from "../src/aggregator.ts";
import type { UsageEntry } from "../src/log-parser.ts";

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    timestamp: new Date("2026-02-11T10:00:00.000Z"),
    model: "m1",
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    messageId: null,
    requestId: null,
    costUSD: 1,
    ...overrides,
  };
}

describe("aggregateByPeriod", () => {
  it("aggregates daily/weekly/monthly costs and token breakdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));

    const entries: UsageEntry[] = [
      entry({
        timestamp: new Date("2026-02-11T11:00:00.000Z"),
        model: "sonnet",
        costUSD: 1.2,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
      }),
      entry({
        timestamp: new Date("2026-02-10T11:00:00.000Z"),
        model: "haiku",
        costUSD: 2.3,
        inputTokens: 5,
        outputTokens: 6,
        cacheCreationTokens: 7,
        cacheReadTokens: 8,
      }),
      entry({
        timestamp: new Date("2026-02-14T11:00:00.000Z"),
        model: "future",
        costUSD: 9.9,
      }),
    ];

    const daily = aggregateByPeriod(entries, "daily", "UTC");
    expect(daily.total).toBeCloseTo(1.2, 8);
    expect(daily.byModel).toEqual({ sonnet: 1.2 });
    expect(daily.tokenBreakdown).toEqual({
      input: 10,
      output: 20,
      cacheCreation: 30,
      cacheRead: 40,
    });

    const weekly = aggregateByPeriod(entries, "weekly", "UTC");
    expect(weekly.total).toBeCloseTo(3.5, 8);
    expect(weekly.byModel).toEqual({ sonnet: 1.2, haiku: 2.3 });

    const monthly = aggregateByPeriod(entries, "monthly", "UTC");
    expect(monthly.total).toBeCloseTo(3.5, 8);

    vi.useRealTimers();
  });

  it("treats missing costUSD as zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T12:00:00.000Z"));

    const result = aggregateByPeriod(
      [
        entry({
          timestamp: new Date("2026-02-11T10:00:00.000Z"),
          model: "m",
          costUSD: null,
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationTokens: 5,
          cacheReadTokens: 6,
        }),
      ],
      "daily",
      "UTC"
    );

    expect(result.total).toBe(0);
    expect(result.byModel).toEqual({ m: 0 });
    expect(result.tokenBreakdown).toEqual({
      input: 3,
      output: 4,
      cacheCreation: 5,
      cacheRead: 6,
    });

    vi.useRealTimers();
  });
});
