import fs from "fs";
import path from "path";

export const acquireDatabaseLock = (databasePath: string, purpose = "database"): (() => void) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(databasePath), 0o700);
  const lockPath = `${databasePath}.lock`;
  const descriptor = openLock(lockPath, purpose);
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    let releaseError: unknown;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      releaseError = error;
    }
    try {
      if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        releaseError ??= error;
      }
    }
    if (releaseError) {
      throw releaseError;
    }
  };
};

const openLock = (lockPath: string, purpose: string): number => {
  try {
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return descriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (!removeStaleLock(lockPath)) {
      throw new Error(`another cceye ${purpose} is already using ${lockPath.slice(0, -5)}`);
    }
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    return descriptor;
  }
};

const removeStaleLock = (lockPath: string): boolean => {
  let contents: string;
  try {
    contents = fs.readFileSync(lockPath, "utf8").trim();
  } catch {
    return false;
  }
  const pid = Number(contents);
  if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) {
    return false;
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
