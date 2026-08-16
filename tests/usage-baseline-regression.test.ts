import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateByPeriod } from "../src/aggregator.ts";
import type { Config } from "../src/config.ts";
import type { ModelPricing } from "../src/pricing.ts";
import type { State } from "../src/state-store.ts";
import { collectUsageEntries } from "../src/usage-collector.ts";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "usage-baseline",
  "mixed-logs",
  "mixed-schema"
);

type CostMode = Config["cost_mode"];

function createState(): State {
  return {
    lastPollAt: null,
    notifications: {
      "daily:warning": null,
      "daily:critical": null,
      "weekly:warning": null,
      "weekly:critical": null,
      "monthly:warning": null,
      "monthly:critical": null,
    },
    notificationHistory: [],
    fileIndex: {},
    cachedCosts: {
      daily: { total: 0, byModel: {} },
      weekly: { total: 0, byModel: {} },
      monthly: { total: 0, byModel: {} },
    },
  };
}

function createConfig(mode: CostMode): Config {
  return {
    claude_data_dir: fixtureRoot,
    polling_interval_milliseconds: 300000,
    timezone: "UTC",
    cost_mode: mode,
    thresholds: {
      daily: { warning: 1, critical: 2 },
      weekly: { warning: 1, critical: 2 },
      monthly: { warning: 1, critical: 2 },
    },
    notifications: {
      console: { enabled: false },
      macos: { enabled: false, sound: false },
      slack: { enabled: false, mention: "" },
      email: { enabled: false, smtp_secure: false },
    },
    notification_cooldown_minutes: 60,
    log_level: "info",
    dashboard: { refresh_interval_seconds: 60 },
  };
}

function createPricing(): ModelPricing {
  const pricingByModel = new Map([
    [
      "claude-sonnet-4-20250514",
      {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheCreatePerMTok: 3.75,
        cacheReadPerMTok: 0.3,
      },
    ],
    [
      "anthropic/claude-sonnet-4-20250514",
      {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheCreatePerMTok: 3.75,
        cacheReadPerMTok: 0.3,
      },
    ],
  ]);

  return {
    getPrice(model: string) {
      return pricingByModel.get(model) ?? null;
    },
  };
}

describe("usage baseline regression", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    vi.spyOn(os, "homedir").mockReturnValue(path.join(process.cwd(), ".tmp-home-usage-regression"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("collects deduplicated entries from mixed logs", async () => {
    const state = createState();
    const warn = vi.fn<(message: string) => void>();
    const entries = await collectUsageEntries(createConfig("auto"), state, createPricing(), { warn });

    expect(warn).not.toHaveBeenCalled();
    expect(entries).toHaveLength(6);

    const tierEntry = entries.find((entry) => entry.messageId === "msg-tier");
    expect(tierEntry).toMatchObject({
      inputTokens: 300000,
      outputTokens: 100000,
      cacheCreationTokens: 200000,
      cacheReadTokens: 50000,
    });

    expect(Object.keys(state.fileIndex).sort()).toEqual([
      "project-alpha/session-one/usage.jsonl",
      "project-beta/session-two/usage.jsonl",
    ]);
  });

  it.each([
    {
      mode: "auto" as const,
      total: null,
      byModel: {
        "claude-sonnet-4-20250514": 0.9921,
        "anthropic/claude-sonnet-4-20250514": 3.165,
        unknown: 0.2,
        "unknown-model": null,
      },
    },
    {
      mode: "calculate" as const,
      total: null,
      byModel: {
        "claude-sonnet-4-20250514": 0.003228,
        "anthropic/claude-sonnet-4-20250514": 3.165,
        unknown: null,
        "unknown-model": null,
      },
    },
    {
      mode: "display" as const,
      total: null,
      byModel: {
        "claude-sonnet-4-20250514": null,
        "anthropic/claude-sonnet-4-20250514": null,
        unknown: 0.2,
        "unknown-model": null,
      },
    },
  ])("keeps deterministic daily totals in $mode mode", async ({ mode, total, byModel }) => {
    const state = createState();
    const entries = await collectUsageEntries(createConfig(mode), state, createPricing(), { warn: vi.fn() });
    const daily = aggregateByPeriod(entries, "daily", "UTC");

    expect(daily.total).toBe(total);
    expect(daily.tokenBreakdown).toEqual({
      input: 300370,
      output: 100185,
      cacheCreation: 200020,
      cacheRead: 50010,
    });
    const expectCost = (actual: number | null | undefined, expected: number | null): void => {
      if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).toBeCloseTo(expected, 8);
      }
    };
    expectCost(daily.byModel["claude-sonnet-4-20250514"], byModel["claude-sonnet-4-20250514"]);
    expectCost(daily.byModel["anthropic/claude-sonnet-4-20250514"], byModel["anthropic/claude-sonnet-4-20250514"]);
    expectCost(daily.byModel.unknown, byModel.unknown);
    expectCost(daily.byModel["unknown-model"], byModel["unknown-model"]);
  });
});
