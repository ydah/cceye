import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { collectUsageIncrementally } from "../ingestion/incremental-collector.js";
import type { ModelPricing } from "../pricing.js";
import { acquireDatabaseLock } from "./database-lock.js";
import { SqliteUsageStorage } from "./sqlite-storage.js";

export function defaultBackupPath(databasePath: string): string {
  return `${databasePath}.${new Date().toISOString().replace(/[:.]/g, "-")}.backup`;
}

export async function backupDatabase(databasePath: string, targetPath = defaultBackupPath(databasePath)): Promise<string> {
  const releaseLock = acquireDatabaseLock(databasePath, "database backup");
  try {
    return await backupDatabaseLocked(databasePath, targetPath);
  } finally {
    releaseLock();
  }
}

async function backupDatabaseLocked(databasePath: string, targetPath: string): Promise<string> {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`database not found: ${databasePath}`);
  }
  if (path.resolve(databasePath) === path.resolve(targetPath)) {
    throw new Error("database backup target must differ from the source");
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const source = new Database(databasePath, { readonly: false });
  try {
    await source.backup(targetPath);
  } finally {
    source.close();
  }
  fs.chmodSync(targetPath, 0o600);
  return targetPath;
}

export async function rebuildDatabase(
  config: Config,
  pricing: ModelPricing,
  logger: { warn(message: string): void }
): Promise<{ backupPath: string; databasePath: string }> {
  const databasePath = config.storage.database_path;
  const releaseLock = acquireDatabaseLock(databasePath, "database rebuild");
  const rebuiltPath = `${databasePath}.rebuild-${Date.now()}`;
  let rebuilt: SqliteUsageStorage | null = null;
  try {
    const backupPath = await backupDatabaseLocked(databasePath, defaultBackupPath(databasePath));
    rebuilt = new SqliteUsageStorage(rebuiltPath);
    await rebuilt.migrate();
    await collectUsageIncrementally(config, rebuilt, pricing, logger);
    const integrity = await rebuilt.checkIntegrity();
    if (!integrity.ok) {
      throw new Error(`rebuilt database integrity check failed: ${integrity.message}`);
    }
    await rebuilt.close();
    rebuilt = null;
    if (!fs.existsSync(rebuiltPath)) {
      throw new Error(`rebuilt database was not created: ${rebuiltPath}`);
    }
    const failedPath = `${databasePath}.failed-${Date.now()}`;
    moveDatabaseFamily(databasePath, failedPath);
    try {
      moveDatabaseFamily(rebuiltPath, databasePath);
    } catch (error) {
      if (!fs.existsSync(databasePath) && fs.existsSync(failedPath)) {
        moveDatabaseFamily(failedPath, databasePath);
      }
      throw error;
    }
    return { backupPath, databasePath };
  } catch (error) {
    if (rebuilt) {
      await rebuilt.close();
    }
    throw error;
  } finally {
    releaseLock();
  }
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
