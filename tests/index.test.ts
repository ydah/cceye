import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPlatform = process.platform;
const originalCwd = process.cwd();

function writeConfig(configPath: string, dataDir: string): void {
  const yaml = `claude_data_dir: ${JSON.stringify(dataDir)}
polling_interval_milliseconds: 300000
timezone: "UTC"
cost_mode: "calculate"
thresholds:
  daily:
    warning: 5
    critical: 10
  weekly:
    warning: 25
    critical: 50
  monthly:
    warning: 80
    critical: 150
notifications:
  console:
    enabled: false
  macos:
    enabled: false
    sound: false
  slack:
    enabled: false
    mention: ""
  email:
    enabled: false
    smtp_secure: false
notification_cooldown_minutes: 60
log_level: "info"
dashboard:
  refresh_interval_seconds: 60
`;
  fs.writeFileSync(configPath, yaml);
}

function writePricingCache(homeDir: string): void {
  const cachePath = path.join(homeDir, ".config", "cceye", "pricing-cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify(
      {
        updatedAt: Date.now(),
        data: {
          "claude-sonnet-4-5-20250929": {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            cache_creation_input_token_cost: 0.00000375,
            cache_read_input_token_cost: 0.0000003,
          },
        },
      },
      null,
      2
    )
  );
}

function writeUsageLog(logDir: string): string {
  const sessionDir = path.join(logDir, "project-a");
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.jsonl");

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const duplicated = {
    timestamp: now.toISOString(),
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 2000,
      },
      model: "claude-sonnet-4-5-20250929",
      id: "msg-1",
    },
    requestId: "req-1",
  };

  const uniqueWithoutIds = {
    timestamp: oneHourAgo.toISOString(),
    message: {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
      model: "claude-sonnet-4-5-20250929",
    },
  };

  fs.writeFileSync(
    filePath,
    [JSON.stringify(duplicated), JSON.stringify(duplicated), JSON.stringify(uniqueWithoutIds)].join("\n") + "\n"
  );
  return filePath;
}

describe("index.ts", () => {
  let tempRoot = "";
  let tempHome = "";
  let dataDir = "";
  let configPath = "";

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-index-"));
    tempHome = path.join(tempRoot, "home");
    dataDir = path.join(tempRoot, "claude-projects");
    configPath = path.join(tempRoot, "config.yaml");

    fs.mkdirSync(tempHome, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    writeConfig(configPath, dataDir);
    writePricingCache(tempHome);
    writeUsageLog(dataDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.chdir(originalCwd);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("throws on unknown command", async () => {
    const index = await import("../src/index.ts");
    await expect(index.main(["unknown"])).rejects.toThrow("Unknown command: unknown");
  });

  it("runs status command and persists current costs", async () => {
    const index = await import("../src/index.ts");
    await index.main(["status", "--config", configPath]);

    const dataPath = path.join(tempHome, ".config", "cceye", "data.json");
    const statePath = path.join(tempHome, ".config", "cceye", "state.json");
    expect(fs.existsSync(dataPath)).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(dataPath, "utf8")) as {
      currentCosts: { daily: number; weekly: number; monthly: number };
    };
    expect(data.currentCosts.daily).toBeCloseTo(0.00594, 8);
    expect(data.currentCosts.weekly).toBeCloseTo(0.00594, 8);
    expect(data.currentCosts.monthly).toBeCloseTo(0.00594, 8);
  });

  it("runs daily report command with json output", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      index.main([
        "daily",
        "--json",
        "--since",
        "20260101",
        "--until",
        "20261231",
        "--offline",
        "--config",
        configPath,
      ])
    ).resolves.toBeUndefined();

    const payload = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(payload).toContain('"key"');
    expect(payload).toContain('"totalCost"');
  });

  it("builds the session report from the ledger", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await index.main([
      "session",
      "--json",
      "--since",
      "20260101",
      "--until",
      "20261231",
      "--offline",
      "--config",
      configPath,
    ]);

    const payload = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(payload).toContain('"key": "project-a/session"');
    expect(payload).toContain('"amountNanos"');
  });

  it("accepts --config before command", async () => {
    const index = await import("../src/index.ts");
    await expect(index.main(["--config", configPath, "status"])).resolves.toBeUndefined();
  });

  it("removes only the first command token from cli args", async () => {
    const index = await import("../src/index.ts");
    expect(index.removeCommandFromArgs(["debug", "--config", configPath])).toEqual(["--config", configPath]);
    expect(index.removeCommandFromArgs(["--config", configPath, "status"])).toEqual(["--config", configPath]);
    expect(index.removeCommandFromArgs(["-d", "debug", "--config", configPath])).toEqual(["-d", "--config", configPath]);
  });

  it("resets notification flags only when started without args", async () => {
    const index = await import("../src/index.ts");
    const stateStore = await import("../src/state-store.ts");
    const state = stateStore.loadState();
    state.notifications["daily:warning"] = "2026-02-11T10:00:00.000Z";
    state.notifications["weekly:critical"] = "2026-02-11T10:00:00.000Z";
    stateStore.saveState(state);

    index.resetNotificationFlagsAtStartupIfNeeded([]);
    const resetState = stateStore.loadState();
    expect(resetState.notifications["daily:warning"]).toBeNull();
    expect(resetState.notifications["weekly:critical"]).toBeNull();

    resetState.notifications["daily:warning"] = "2026-02-11T11:00:00.000Z";
    stateStore.saveState(resetState);
    index.resetNotificationFlagsAtStartupIfNeeded(["-d"]);
    const notResetState = stateStore.loadState();
    expect(notResetState.notifications["daily:warning"]).toBe("2026-02-11T11:00:00.000Z");
  });

  it("prints package version with --version", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const packageJson = JSON.parse(fs.readFileSync(path.join(originalCwd, "package.json"), "utf8")) as {
      version: string;
    };

    await expect(index.main(["--version"])).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(packageJson.version);
  });

  it("prints help without requiring a config file", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(index.main(["--help"])).resolves.toBeUndefined();

    expect(String(logSpy.mock.calls[0]?.[0])).toContain("Usage: cceye");
  });

  it("supports JSON status output", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await index.main(["status", "--json", "--config", configPath]);

    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, number>;
    expect(output).toMatchObject({ daily: expect.any(Number), weekly: expect.any(Number), monthly: expect.any(Number) });
  });

  it("persists alert deliveries and records partial notification success", async () => {
    const index = await import("../src/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { loadPricing } = await import("../src/pricing.ts");
    const { createLogger } = await import("../src/logger.ts");
    const { SqliteUsageStorage } = await import("../src/storage/sqlite-storage.ts");

    const config = loadConfig(configPath);
    config.thresholds.daily.warning = 0.001;
    config.thresholds.daily.critical = 1;
    const pricing = await loadPricing();
    const logger = createLogger(config);
    logger.silent = true;
    const router = {
      channelNames: vi.fn(() => ["success-channel", "failed-channel"]),
      sendChannel: vi.fn(async (channel: string) =>
        channel === "success-channel"
          ? { channel, status: "success" as const }
          : { channel, status: "failed" as const, error: "delivery failed" }
      ),
    };
    const storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();

    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);

    const deliveries = await storage.listDeliveries(Date.now() + 60_000, 10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("retrying");
    expect(router.sendChannel).toHaveBeenCalledTimes(2);
    await storage.close();
  });

  it("does not create duplicate firing deliveries after all channels fail", async () => {
    const index = await import("../src/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { loadPricing } = await import("../src/pricing.ts");
    const { createLogger } = await import("../src/logger.ts");
    const { SqliteUsageStorage } = await import("../src/storage/sqlite-storage.ts");

    const config = loadConfig(configPath);
    config.thresholds.daily.warning = 0.001;
    config.thresholds.daily.critical = 1;
    const pricing = await loadPricing({ offline: true });
    const logger = createLogger(config);
    logger.silent = true;
    const router = {
      channelNames: vi.fn(() => ["failed-channel"]),
      sendChannel: vi.fn(async (channel: string) => ({ channel, status: "failed" as const, error: "offline" })),
    };
    const storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();

    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);

    expect(router.sendChannel).toHaveBeenCalledTimes(1);
    expect((await storage.getDeliveryCounts()).retrying).toBe(1);
    await storage.close();
  });

  it("sends a recovery notification after a threshold clears", async () => {
    const index = await import("../src/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { loadPricing } = await import("../src/pricing.ts");
    const { createLogger } = await import("../src/logger.ts");
    const { SqliteUsageStorage } = await import("../src/storage/sqlite-storage.ts");

    const config = loadConfig(configPath);
    config.thresholds.daily.warning = 0.001;
    config.thresholds.daily.critical = 1;
    config.alerts.notify_on_recovery = true;
    const pricing = await loadPricing();
    const logger = createLogger(config);
    logger.silent = true;
    const router = {
      channelNames: vi.fn(() => ["test"]),
      sendChannel: vi.fn(async (channel: string) => ({ channel, status: "success" as const })),
    };
    const storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();

    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    config.thresholds.daily.warning = 5;
    config.thresholds.daily.critical = 10;
    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);

    expect(router.sendChannel).toHaveBeenCalledTimes(2);
    expect((await storage.getDeliveryCounts()).delivered).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(tempHome, ".config", "cceye", "state.json"), "utf8")).activeAlerts.daily).toBeNull();
    await storage.close();
  });

  it("keeps recovery active until a failed delivery is retried successfully", async () => {
    const index = await import("../src/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { loadPricing } = await import("../src/pricing.ts");
    const { createLogger } = await import("../src/logger.ts");
    const { SqliteUsageStorage } = await import("../src/storage/sqlite-storage.ts");
    const { loadState } = await import("../src/state-store.ts");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    writeUsageLog(dataDir);
    const config = loadConfig(configPath);
    config.thresholds.daily.warning = 0.001;
    config.thresholds.daily.critical = 1;
    config.alerts.notify_on_recovery = true;
    const pricing = await loadPricing({ offline: true });
    const logger = createLogger(config);
    logger.silent = true;
    let calls = 0;
    const router = {
      channelNames: vi.fn(() => ["test"]),
      sendChannel: vi.fn(async (channel: string) => {
        calls += 1;
        return calls === 2
          ? { channel, status: "failed" as const, error: "recovery unavailable" }
          : { channel, status: "success" as const };
      }),
    };
    const storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();

    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    config.thresholds.daily.warning = 5;
    config.thresholds.daily.critical = 10;
    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    expect(loadState().activeAlerts.daily).toBe("warning");

    vi.advanceTimersByTime(10_000);
    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    expect(calls).toBe(3);
    expect(loadState().activeAlerts.daily).toBeNull();

    const statePath = path.join(tempHome, ".config", "cceye", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { activeAlerts: { daily: string | null } };
    state.activeAlerts.daily = "warning";
    fs.writeFileSync(statePath, JSON.stringify(state));
    await index.pollOnce(config, pricing, router as never, logger, false, undefined, true, storage);
    expect(calls).toBe(3);
    expect(loadState().activeAlerts.daily).toBeNull();
    await storage.close();
  });

  it("exposes pricing, billing, reconciliation, doctor, and explicit notification commands", async () => {
    const index = await import("../src/index.ts");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await index.main(["prices", "explain", "claude-sonnet-4-5-20250929", "--offline", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("Cache read");

    await index.main(["billing", "status", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"records"');

    await index.main(["reconcile", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"estimatedCoverage"');

    await index.main(["doctor", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"checks"');

    await index.main(["notifications", "reset"]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("reset");

    await index.main(["notify", "test", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"test":true');

    await index.main(["db", "check", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"ok":true');
    await index.main(["db", "backup", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"backupPath"');

    const { loadConfig } = await import("../src/config.ts");
    const { SqliteUsageStorage } = await import("../src/storage/sqlite-storage.ts");
    const loadedConfig = loadConfig(configPath);
    const retryStorage = new SqliteUsageStorage(loadedConfig.storage.database_path);
    await retryStorage.createAlert({
      id: "cli-alert",
      fingerprint: "cli-alert",
      windowKey: "daily",
      windowStartMs: 0,
      level: "warning",
      state: "firing",
      currentAmountNanos: 1n,
      thresholdAmountNanos: 1n,
      firstSeenAtMs: 1,
      lastSeenAtMs: 1,
      resolvedAtMs: null,
    });
    await retryStorage.enqueueDelivery({
      id: "cli-delivery",
      alertId: "cli-alert",
      channel: "test",
      transition: "firing",
      status: "dead",
      attempts: 5,
      nextAttemptAtMs: 0,
      lastError: "failed",
      idempotencyKey: "cli-key",
      createdAtMs: 1,
      deliveredAtMs: null,
    });
    await retryStorage.close();
    await index.main(["alerts", "retry", "cli-delivery", "--json", "--config", configPath]);
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"retried":true');

    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const isolatedProjects = path.join(tempRoot, "projects");
    fs.cpSync(dataDir, isolatedProjects, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = isolatedProjects;
    await index.main(["db", "rebuild", "--json", "--config", configPath]);
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('"databasePath"');
  });

  it("treats symlinked executable path as direct run", async () => {
    const index = await import("../src/index.ts");
    const actualScriptPath = path.join(tempRoot, "actual-index.js");
    const symlinkPath = path.join(tempRoot, "symlink-index.js");

    fs.writeFileSync(actualScriptPath, "");
    fs.symlinkSync(actualScriptPath, symlinkPath);

    expect(index.isDirectRunPath(undefined, pathToFileURL(actualScriptPath).href)).toBe(false);
    expect(index.isDirectRunPath(symlinkPath, pathToFileURL(actualScriptPath).href)).toBe(true);
  });

  it("deduplicates entries in collectUsageEntries", async () => {
    const index = await import("../src/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { loadState } = await import("../src/state-store.ts");
    const { loadPricing } = await import("../src/pricing.ts");

    const config = loadConfig(configPath);
    const state = loadState();
    const pricing = await loadPricing();
    const logger = { warn: vi.fn() };

    const entries = await index.collectUsageEntries(config, state, pricing, logger);
    expect(entries).toHaveLength(2);
    expect(state.fileIndex).toHaveProperty("project-a/session.jsonl");
  });

  it("builds model breakdown and hourly trend", async () => {
    const index = await import("../src/index.ts");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T12:30:00.000Z"));

    const trend = index.hourlyTrend([
      {
        timestamp: new Date("2026-02-11T12:10:00.000Z"),
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        messageId: null,
        requestId: null,
        costUSD: 1,
      },
      {
        timestamp: new Date("2026-02-11T12:20:00.000Z"),
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        messageId: null,
        requestId: null,
        costUSD: 2,
      },
      {
        timestamp: new Date("2026-02-10T11:00:00.000Z"),
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        messageId: null,
        requestId: null,
        costUSD: 3,
      },
    ]);

    expect(trend).toEqual([{ hour: "2026-02-11T12:00:00.000Z", cost: 3 }]);

    expect(
      index.hourlyTrend([
        {
          timestamp: new Date("2026-02-11T12:10:00.000Z"),
          model: "unknown",
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          messageId: null,
          requestId: null,
          costUSD: null,
        },
      ])
    ).toEqual([]);
    expect(index.toModelBreakdown({ a: 1, b: 2 })).toEqual([
      { model: "a", cost: 1 },
      { model: "b", cost: 2 },
    ]);
    expect(index.toProjectBreakdown({ p1: 1, p2: 2 })).toEqual([
      { project: "p1", cost: 1 },
      { project: "p2", cost: 2 },
    ]);

    const poll = index.nextPoll(5000);
    expect(poll.getTime()).toBeGreaterThan(Date.now());
  });

  it("writes config interactively with initConfig", async () => {
    const index = await import("../src/index.ts");
    const isolatedCwd = path.join(tempRoot, "empty-cwd");
    fs.mkdirSync(isolatedCwd, { recursive: true });
    process.chdir(isolatedCwd);

    const question = vi
      .fn<(q: string, cb: (answer: string) => void) => void>()
      .mockImplementationOnce((_q, cb) => cb("/tmp/claude"))
      .mockImplementationOnce((_q, cb) => cb("10000"))
      .mockImplementationOnce((_q, cb) => cb("Asia/Tokyo"))
      .mockImplementationOnce((_q, cb) => cb("auto"));
    const close = vi.fn();
    vi.spyOn(readline, "createInterface").mockReturnValue({
      question,
      close,
    } as unknown as readline.Interface);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await index.initConfig();

    const createdPath = path.join(tempHome, ".config", "cceye", "config.yaml");
    expect(fs.existsSync(createdPath)).toBe(true);
    const content = fs.readFileSync(createdPath, "utf8");
    expect(content).toContain('claude_data_dir: "/tmp/claude"');
    expect(content).toContain("polling_interval_milliseconds: 10000");
    expect(content).toContain('timezone: "Asia/Tokyo"');
    expect(content).toContain('cost_mode: "auto"');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns gracefully for install/uninstall on non-macOS", async () => {
    const index = await import("../src/index.ts");
    Object.defineProperty(process, "platform", { value: "linux" });

    await expect(index.main(["install", "--config", configPath])).resolves.toBeUndefined();
    await expect(index.main(["uninstall", "--config", configPath])).resolves.toBeUndefined();
  });
});
