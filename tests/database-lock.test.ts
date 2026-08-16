import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDatabaseLock } from "../src/storage/database-lock.ts";

describe("database lock", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reclaims a lock owned by a dead process", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-lock-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    fs.writeFileSync(`${databasePath}.lock`, `${Number.MAX_SAFE_INTEGER}\n`);

    const release = acquireDatabaseLock(databasePath, "test");
    expect(fs.readFileSync(`${databasePath}.lock`, "utf8")).toBe(`${process.pid}\n`);
    release();
    expect(fs.existsSync(`${databasePath}.lock`)).toBe(false);
  });

  it("does not reclaim a lock owned by this process", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-lock-"));
    directories.push(directory);
    const databasePath = path.join(directory, "cceye.db");
    const release = acquireDatabaseLock(databasePath, "test");

    expect(() => acquireDatabaseLock(databasePath, "test")).toThrow("another cceye test is already using");
    release();
  });
});
