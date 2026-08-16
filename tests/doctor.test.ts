import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/diagnostics/doctor.ts";
import type { Config } from "../src/config.ts";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";

describe("doctor", () => {
  const resources: Array<{ directory: string; storage: SqliteUsageStorage }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await resource.storage.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it("reports an empty but healthy local setup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-doctor-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    resources.push({ directory, storage });
    await storage.migrate();
    await storage.insertUsageEvents([
      {
        eventId: "doctor-unpriced-event",
        source: { sourceKind: "claude", canonicalPath: path.join(directory, "usage.jsonl"), fileIdentity: "doctor-file" },
        generation: 0,
        occurredAtMs: Date.now(),
        project: "doctor-project",
        session: "doctor-session",
        modelRaw: "unknown-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reportedCostNanos: null,
        schemaFingerprint: null,
        ingestedAtMs: Date.now(),
      },
    ]);
    const config = {
      claude_data_dir: path.join(directory, "missing"),
      polling_interval_milliseconds: 1000,
      timezone: "UTC",
      cost_mode: "auto",
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
      storage: { database_path: path.join(directory, "cceye.db") },
      pricing: { aliases: {} },
      billing: { anthropic: { enabled: false, api_key_env: "CCEYE_TEST_ADMIN_KEY" } },
    } as Config;
    fs.mkdirSync(config.claude_data_dir, { recursive: true });
    fs.writeFileSync(path.join(config.claude_data_dir, "usage.jsonl"), "{}\n");
    await storage.recordIngestionHealth({
      scannedFiles: 1,
      changedFiles: 1,
      bytesRead: 3,
      parsedLines: 1,
      usageLines: 0,
      malformedLines: 1,
      schemaRejectedLines: 0,
      duplicateLines: 0,
      unpricedEvents: 1,
      lastSuccessfulIngestionMs: 1,
      durationMs: 1,
    });

    const report = await runDoctor(config, storage);
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.name === "Database integrity" && check.status === "ok")).toBe(true);
  });
});
