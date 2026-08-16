import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase, rebuildDatabase } from "../src/storage/database-management.ts";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";
import type { Config } from "../src/config.ts";

describe("database management", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates a private SQLite backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    const storage = new SqliteUsageStorage(databasePath);
    await storage.migrate();
    await storage.close();

    const target = path.join(directory, "backup.db");
    await expect(backupDatabase(databasePath, target)).resolves.toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("rejects backups for a missing database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    await expect(backupDatabase(path.join(directory, "missing.db"))).rejects.toThrow("database not found");
  });

  it("rebuilds the database from the complete JSONL source", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const dataRoot = path.join(directory, "projects");
    fs.mkdirSync(path.join(dataRoot, "project"), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "project", "session.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        message: { model: "model", usage: { input_tokens: 1, output_tokens: 1 } },
      })}\n`
    );
    const databasePath = path.join(directory, "cceye.db");
    const initial = new SqliteUsageStorage(databasePath);
    await initial.migrate();
    await initial.close();
    const config = {
      claude_data_dir: dataRoot,
      polling_interval_milliseconds: 1000,
      timezone: "UTC",
      cost_mode: "calculate",
      thresholds: {
        daily: { warning: 1, critical: 2 },
        weekly: { warning: 1, critical: 2 },
        monthly: { warning: 1, critical: 2 },
      },
      notifications: {
        console: { enabled: false },
        macos: { enabled: false, sound: false },
        slack: { enabled: false },
        email: { enabled: false, smtp_secure: false },
      },
      notification_cooldown_minutes: 60,
      log_level: "info",
      dashboard: { refresh_interval_seconds: 60 },
      storage: { database_path: databasePath },
      pricing: { aliases: {} },
      billing: { anthropic: { enabled: false, api_key_env: "CCEYE_TEST_KEY" } },
      alerts: { notify_on_recovery: false, max_retries: 5 },
    } as Config;
    const pricing = {
      getPrice: () => ({ inputPerMTok: 1, outputPerMTok: 1, cacheCreatePerMTok: 1, cacheReadPerMTok: 1 }),
      explain: () => ({ matchedModel: "model", matchType: "exact" as const }),
      source: "test",
      catalogHash: "hash",
    };

    const result = await rebuildDatabase(config, pricing, { warn: () => {} });
    expect(fs.existsSync(result.backupPath)).toBe(true);
    const rebuilt = new SqliteUsageStorage(databasePath);
    await expect(rebuilt.checkIntegrity()).resolves.toEqual({ ok: true, message: "ok" });
    await expect(rebuilt.queryUsage({ fromMs: Date.now() - 60_000, untilMs: Date.now() + 1, basis: "estimated" })).resolves.toMatchObject({ events: 1 });
    await rebuilt.close();
  });
});
