import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalPlatform = process.platform;
const originalCwd = process.cwd();

function writeConfig(configPath: string, dataDir: string): void {
  const yaml = `claude_data_dir: "${dataDir}"
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

    writeConfig(configPath, dataDir);
    writePricingCache(tempHome);
    writeUsageLog(dataDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env.HOME = originalHome;
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
    expect(index.toModelBreakdown({ a: 1, b: 2 })).toEqual([
      { model: "a", cost: 1 },
      { model: "b", cost: 2 },
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
