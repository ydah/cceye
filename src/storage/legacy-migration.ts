import fs from "fs";
import os from "os";
import path from "path";

export interface LegacyBackupResult {
  databaseWasNew: boolean;
  backups: string[];
}

export const backupLegacyFilesBeforeFirstDatabaseUse = (databasePath: string): LegacyBackupResult => {
  const databaseWasNew = !fs.existsSync(databasePath);
  if (!databaseWasNew) {
    return { databaseWasNew: false, backups: [] };
  }
  const configDir = path.join(os.homedir(), ".config", "cceye");
  const backups: string[] = [];
  for (const name of ["state.json", "data.json", "pricing-cache.json"]) {
    const source = path.join(configDir, name);
    const backup = `${source}.backup-v1`;
    if (!fs.existsSync(source) || fs.existsSync(backup)) {
      continue;
    }
    fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    backups.push(backup);
  }
  return { databaseWasNew, backups };
};
