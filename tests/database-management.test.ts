import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("rejects overwriting the source with its own backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    const storage = new SqliteUsageStorage(databasePath);
    await storage.migrate();
    await storage.close();

    await expect(backupDatabase(databasePath, databasePath)).rejects.toThrow("target must differ");
  });

  it("preserves a database that cannot be opened", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "broken.db");
    fs.writeFileSync(databasePath, "not sqlite");

    await expect(async () => new SqliteUsageStorage(databasePath)).rejects.toThrow("preserved failed database");
    expect(fs.readdirSync(directory).some((name) => name.startsWith("broken.db.failed-"))).toBe(true);
  });

  it("migrates the v1 delivery and billing tables", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 1);
      CREATE TABLE alert_instances (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, window_key TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL, level TEXT NOT NULL, state TEXT NOT NULL, current_amount_nanos INTEGER NOT NULL,
        threshold_amount_nanos INTEGER NOT NULL, first_seen_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER);
      CREATE TABLE delivery_outbox (id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, channel TEXT NOT NULL,
        transition TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL, last_error TEXT, idempotency_key TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL, delivered_at_ms INTEGER,
        FOREIGN KEY(alert_id) REFERENCES alert_instances(id));
      CREATE TABLE billing_records (record_id TEXT PRIMARY KEY, provider TEXT NOT NULL, period_start_ms INTEGER NOT NULL,
        period_end_ms INTEGER NOT NULL, amount_nanos INTEGER NOT NULL, currency TEXT NOT NULL,
        dimensions_json TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL);
    `);
    legacy.close();

    const storage = new SqliteUsageStorage(databasePath);
    await storage.migrate();
    await storage.createAlert({
      id: "legacy-alert",
      fingerprint: "legacy",
      windowKey: "daily",
      windowStartMs: 0,
      level: "warning",
      state: "firing",
      currentAmountNanos: 1n,
      thresholdAmountNanos: 1n,
      firstSeenAtMs: 0,
      lastSeenAtMs: 0,
      resolvedAtMs: null,
    });
    await storage.enqueueDelivery({
      id: "legacy-delivery",
      alertId: "legacy-alert",
      channel: "test",
      transition: "firing",
      status: "pending",
      attempts: 0,
      nextAttemptAtMs: 0,
      lastError: null,
      idempotencyKey: "legacy-key",
      createdAtMs: 0,
      deliveredAtMs: null,
    });
    expect(await storage.claimDeliveries(0, 1)).toHaveLength(1);
    await storage.close();
  });

  it("closes a staged rebuild when source discovery fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    const initial = new SqliteUsageStorage(databasePath);
    await initial.migrate();
    await initial.close();
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(directory, "missing-config");
    try {
      await expect(
        rebuildDatabase(
          { storage: { database_path: databasePath } } as Config,
          { getPrice: () => null },
          { warn: () => {} }
        )
      ).rejects.toThrow("no valid Claude data directories");
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("restores the original database if the staged swap fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-db-management-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    const initial = new SqliteUsageStorage(databasePath);
    await initial.migrate();
    await initial.close();
    const originalRename = fs.renameSync;
    vi.spyOn(Date, "now").mockReturnValue(123456789);
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith(".rebuild-123456789")) {
        throw new Error("staged swap failed");
      }
      return originalRename(source, target);
    });
    try {
      await expect(
        rebuildDatabase(
          { storage: { database_path: databasePath }, claude_data_dir: path.join(directory, "missing-projects"), cost_mode: "calculate" } as Config,
          { getPrice: () => null },
          { warn: () => {} }
        )
      ).rejects.toThrow("staged swap failed");
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.existsSync(databasePath)).toBe(true);
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
