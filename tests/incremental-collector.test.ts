import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { collectUsageIncrementally } from "../src/ingestion/incremental-collector.ts";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";

describe("collectUsageIncrementally", () => {
  const resources: Array<{ directory: string; storage: SqliteUsageStorage }> = [];
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await resource.storage.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  });

  it("reads only appended bytes and resumes a partial final line", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ingestion-"));
    const root = path.join(directory, "projects");
    const logDirectory = path.join(root, "project-a", "session-one");
    fs.mkdirSync(logDirectory, { recursive: true });
    const file = path.join(logDirectory, "usage.jsonl");
    const databasePath = path.join(directory, "cceye.db");
    process.env.CLAUDE_CONFIG_DIR = directory;
    const storage = new SqliteUsageStorage(databasePath);
    resources.push({ directory, storage });
    await storage.migrate();

    const configPath = path.join(directory, "config.yaml");
    const configContent = [
      `claude_data_dir: "${root}"`,
      "polling_interval_milliseconds: 1000",
      'timezone: "UTC"',
      'cost_mode: "calculate"',
      "thresholds:",
      "  daily: { warning: 1, critical: 2 }",
      "  weekly: { warning: 1, critical: 2 }",
      "  monthly: { warning: 1, critical: 2 }",
      "notifications:",
      "  console: { enabled: false }",
      "  macos: { enabled: false, sound: false }",
      "  slack: { enabled: false }",
      "  email: { enabled: false, smtp_secure: false }",
      "notification_cooldown_minutes: 60",
      'log_level: "info"',
      "dashboard: { refresh_interval_seconds: 60 }",
      `storage: { database_path: "${databasePath}" }`,
    ].join("\n");
    fs.writeFileSync(configPath, `${configContent}\n`);
    const config = loadConfig(configPath);
    const pricing = {
      source: "test",
      getPrice: () => ({ inputPerMTok: 1, outputPerMTok: 2, cacheCreatePerMTok: 0, cacheReadPerMTok: 0 }),
      explain: () => ({ matchedModel: "model", matchType: "exact" as const }),
    };
    const line = JSON.stringify({
      timestamp: "2026-08-16T00:00:00.000Z",
      message: { model: "model", id: "message-1", usage: { input_tokens: 1, output_tokens: 1 } },
      requestId: "request-1",
    });
    fs.writeFileSync(file, `${line}\n{"timestamp":"2026-08-16T00:01:00.000Z",`);

    const first = await collectUsageIncrementally(config, storage, pricing, { warn: () => {} });
    expect(first.entries).toHaveLength(1);
    expect(first.metrics.changedFiles).toBe(1);
    expect(first.metrics.bytesRead).toBe(fs.statSync(file).size);

    const second = await collectUsageIncrementally(config, storage, pricing, { warn: () => {} });
    expect(second.entries).toHaveLength(0);
    expect(second.metrics.changedFiles).toBe(0);
    expect(second.metrics.bytesRead).toBe(0);

    fs.appendFileSync(file, `"message":{"model":"model","usage":{"input_tokens":2,"output_tokens":1}}}\n`);
    const third = await collectUsageIncrementally(config, storage, pricing, { warn: () => {} });
    expect(third.entries).toHaveLength(1);
    expect(third.metrics.bytesRead).toBeGreaterThan(0);

    fs.appendFileSync(file, `${JSON.stringify({ timestamp: 123, message: {} })}\n`);
    const fourth = await collectUsageIncrementally(config, storage, pricing, { warn: () => {} });
    expect(fourth.metrics.schemaRejectedLines).toBe(1);
    await expect(storage.listParserErrors(10)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "schema_rejected" })])
    );

    const summary = await storage.queryUsage({ fromMs: 0, untilMs: Date.now() + 1, basis: "estimated" });
    expect(summary.events).toBe(2);
    expect(summary.coverage.complete).toBe(true);
  });
});
