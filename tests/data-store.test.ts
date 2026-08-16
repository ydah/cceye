import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("data-store", () => {
  let tempDir = "";
  let tempHome = "";

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-data-"));
    tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty data when file does not exist", async () => {
    const { loadData, createEmptyData } = await import("../src/data-store.ts");
    expect(loadData()).toEqual(createEmptyData());
  });

  it("saves and loads data with merged defaults", async () => {
    const mod = await import("../src/data-store.ts");
    const data = mod.createEmptyData();
    mod.updateCurrentCosts(data, { daily: 1.2, weekly: 2.3, monthly: 3.4 });
    mod.updateModelBreakdown(data, { daily: [{ model: "m1", cost: 1.2 }] });
    mod.updateProjectBreakdown(data, { daily: [{ project: "project-a", cost: 1.2 }] });
    mod.updateHourlyTrend(data, [{ hour: new Date().toISOString(), cost: 1 }]);
    mod.addNotificationHistory(data, {
      timestamp: new Date().toISOString(),
      level: "warning",
      window: "daily",
      currentCost: 1.2,
      threshold: 1.0,
      channels: ["console"],
    });
    mod.markUpdated(data, new Date("2026-02-11T00:00:00.000Z"));
    mod.saveData(data);

    const loaded = mod.loadData();
    expect(loaded.currentCosts.daily).toBe(1.2);
    expect(loaded.modelBreakdown.daily).toHaveLength(1);
    expect(loaded.projectBreakdown.daily).toHaveLength(1);
    expect(loaded.notificationHistory).toHaveLength(1);
    expect(loaded.lastUpdated).toContain("2026-02-11");
  });

  it("handles invalid JSON by returning empty data", async () => {
    const dataPath = path.join(tempHome, ".config", "cceye", "data.json");
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, "{broken-json");

    const { loadData, createEmptyData } = await import("../src/data-store.ts");
    expect(loadData()).toEqual(createEmptyData());
  });

  it("handles invalid schema by returning empty data", async () => {
    const dataPath = path.join(tempHome, ".config", "cceye", "data.json");
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify({ currentCosts: { daily: "broken" } }, null, 2));

    const { loadData, createEmptyData } = await import("../src/data-store.ts");
    expect(loadData()).toEqual(createEmptyData());
  });

  it("repairs permissions on an existing data file", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataPath = path.join(tempHome, ".config", "cceye", "data.json");
    fs.mkdirSync(path.dirname(dataPath), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(dataPath), 0o755);
    fs.writeFileSync(dataPath, JSON.stringify({}), { mode: 0o644 });
    fs.chmodSync(dataPath, 0o644);
    const { loadData } = await import("../src/data-store.ts");

    loadData();

    expect(fs.statSync(path.dirname(dataPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(dataPath).mode & 0o777).toBe(0o600);
  });
});
