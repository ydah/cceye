import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateByPeriod } from "../src/aggregator.ts";
import type { Config } from "../src/config.ts";
import type { ModelPricing } from "../src/pricing.ts";
import type { State } from "../src/state-store.ts";
import { collectUsageEntries } from "../src/usage-collector.ts";

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

function createConfig(pathHint: string): Config {
  return {
    claude_data_dir: pathHint,
    polling_interval_milliseconds: 300000,
    timezone: "UTC",
    cost_mode: "display",
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

describe("collectUsageEntries with multiple roots", () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-roots-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates across roots and avoids file index key collisions", async () => {
    const configDirA = path.join(tempRoot, "claude-a");
    const configDirB = path.join(tempRoot, "claude-b");
    const sessionA = path.join(configDirA, "projects", "project-a", "session-one");
    const sessionB = path.join(configDirB, "projects", "project-a", "session-one");
    fs.mkdirSync(sessionA, { recursive: true });
    fs.mkdirSync(sessionB, { recursive: true });

    const duplicateLine = JSON.stringify({
      timestamp: "2026-02-15T10:00:00.000Z",
      message: {
        usage: { input_tokens: 1, output_tokens: 1 },
        id: "message-1",
      },
      requestId: "request-1",
      costUSD: 0.3,
    });
    const uniqueLine = JSON.stringify({
      timestamp: "2026-02-15T11:00:00.000Z",
      message: {
        usage: { input_tokens: 2, output_tokens: 2 },
        id: "message-2",
      },
      requestId: "request-2",
      costUSD: 0.2,
    });

    fs.writeFileSync(path.join(sessionA, "usage.jsonl"), `${duplicateLine}\n`);
    fs.writeFileSync(path.join(sessionB, "usage.jsonl"), `${duplicateLine}\n${uniqueLine}\n`);

    process.env.CLAUDE_CONFIG_DIR = `${configDirA},${configDirB}`;
    const pricing: ModelPricing = { getPrice: () => null };
    const state = createState();
    const entries = await collectUsageEntries(createConfig(path.join(tempRoot, "ignored")), state, pricing, {
      warn: vi.fn(),
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.project).sort()).toEqual(["project-a", "project-a"]);
    expect(entries.map((entry) => entry.session).sort()).toEqual(["session-one", "session-one"]);
    const daily = aggregateByPeriod(entries, "daily", "UTC");
    expect(daily.total).toBeCloseTo(0.5, 8);
    expect(daily.byProject).toEqual({ "project-a": 0.5 });

    expect(Object.keys(state.fileIndex).sort()).toEqual([
      "0::project-a/session-one/usage.jsonl",
      "1::project-a/session-one/usage.jsonl",
    ]);
  });

  it("logs a redacted warning when no logs are found in configured roots", async () => {
    const configDirA = path.join(tempRoot, "claude-a");
    const configDirB = path.join(tempRoot, "claude-b");
    fs.mkdirSync(path.join(configDirA, "projects"), { recursive: true });
    fs.mkdirSync(path.join(configDirB, "projects"), { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = `${configDirA},${configDirB}`;
    const warn = vi.fn<(message: string) => void>();
    const entries = await collectUsageEntries(
      createConfig(path.join(tempRoot, "ignored")),
      createState(),
      { getPrice: () => null },
      { warn }
    );

    expect(entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith("no session logs found in any of the 2 configured root(s)");
    expect(warn.mock.calls[0]?.[0]).not.toContain(configDirA);
    expect(warn.mock.calls[0]?.[0]).not.toContain(configDirB);
  });

  it("sanitizes project and session labels from filesystem paths", async () => {
    const configDir = path.join(tempRoot, "claude-control");
    const project = "project-\u001b[31m";
    const session = "session-\u001b[31m";
    const sessionDir = path.join(configDir, "projects", project, session);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "usage.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-02-15T10:00:00.000Z",
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
        costUSD: 0.3,
      })}\n`
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const entries = await collectUsageEntries(createConfig(path.join(tempRoot, "ignored")), createState(), {
      getPrice: () => null,
    }, { warn: vi.fn() });

    expect(entries[0]?.project).toBe("project-�[31m");
    expect(entries[0]?.session).toBe("session-�[31m");
  });
});
