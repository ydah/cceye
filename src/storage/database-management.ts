import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { collectUsageIncrementally } from "../ingestion/incremental-collector.js";
import type { ModelPricing } from "../pricing.js";
import { SqliteUsageStorage } from "./sqlite-storage.js";

export function defaultBackupPath(databasePath: string): string {
  return `${databasePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.backup`;
}

export async function backupDatabase(databasePath: string, targetPath = defaultBackupPath(databasePath)): Promise<string> {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`database not found: ${databasePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new Database(databasePath, { readonly: false });
  try {
    source.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    source.close();
  }
  fs.copyFileSync(databasePath, targetPath);
  fs.chmodSync(targetPath, 0o600);
  return targetPath;
}

export async function rebuildDatabase(
  config: Config,
  pricing: ModelPricing,
  logger: { warn(message: string): void }
): Promise<{ backupPath: string; databasePath: string }> {
  const databasePath = config.storage.database_path;
  const backupPath = await backupDatabase(databasePath);
  const rebuiltPath = `${databasePath}.rebuild-${Date.now()}`;
  const rebuilt = new SqliteUsageStorage(rebuiltPath);
  try {
    await rebuilt.migrate();
    await collectUsageIncrementally(config, rebuilt, pricing, logger);
    await rebuilt.close();
    moveDatabaseFamily(databasePath, `${databasePath}.failed-${Date.now()}`);
    moveDatabaseFamily(rebuiltPath, databasePath);
  } catch (error) {
    await rebuilt.close();
    throw error;
  }
  return { backupPath, databasePath };
}

function moveDatabaseFamily(source: string, target: string): void {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.renameSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    const sourceSidecar = `${source}${suffix}`;
    if (fs.existsSync(sourceSidecar)) {
      fs.renameSync(sourceSidecar, `${target}${suffix}`);
    }
  }
}
