import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("state-store", () => {
  let tempDir = "";
  let tempHome = "";

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-state-"));
    tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty state when file missing or malformed", async () => {
    const mod = await import("../src/state-store.ts");
    const empty = mod.loadState();
    expect(empty.lastPollAt).toBeNull();

    const statePath = path.join(tempHome, ".config", "cceye", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{broken-json");
    const malformed = mod.loadState();
    expect(malformed.lastPollAt).toBeNull();
  });

  it("returns empty state when file has invalid schema", async () => {
    const mod = await import("../src/state-store.ts");
    const statePath = path.join(tempHome, ".config", "cceye", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ lastPollAt: 123 }, null, 2));

    const loaded = mod.loadState();
    expect(loaded).toEqual({
      lastPollAt: null,
      notifications: {
        "daily:warning": null,
        "daily:critical": null,
        "weekly:warning": null,
        "weekly:critical": null,
        "monthly:warning": null,
        "monthly:critical": null,
      },
      notificationHistory: [],
      fileIndex: {},
      cachedCosts: {
        daily: { total: 0, byModel: {} },
        weekly: { total: 0, byModel: {} },
        monthly: { total: 0, byModel: {} },
      },
    });
  });

  it("persists state and evaluates cooldown", async () => {
    const mod = await import("../src/state-store.ts");
    const state = mod.loadState();
    mod.recordNotification(state, {
      timestamp: "2026-02-11T10:00:00.000Z",
      window: "daily",
      level: "warning",
      cost: 1,
      threshold: 2,
    });
    mod.saveState(state);

    const reloaded = mod.loadState();
    expect(reloaded.notificationHistory).toHaveLength(1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-11T10:10:00.000Z"));
    expect(mod.shouldNotify("daily", "warning", reloaded, 30)).toBe(false);
    vi.setSystemTime(new Date("2026-02-11T10:40:01.000Z"));
    expect(mod.shouldNotify("daily", "warning", reloaded, 30)).toBe(true);
  });

  it("resets window state when period boundary crossed", async () => {
    const mod = await import("../src/state-store.ts");
    const state = mod.loadState();
    state.lastPollAt = "2026-01-31T00:00:00.000Z";
    state.notifications["daily:warning"] = "2026-02-10T00:00:00.000Z";
    state.notifications["weekly:warning"] = "2026-02-10T00:00:00.000Z";
    state.notifications["monthly:warning"] = "2026-02-10T00:00:00.000Z";
    state.cachedCosts.daily.total = 1;
    state.cachedCosts.weekly.total = 1;
    state.cachedCosts.monthly.total = 1;

    mod.resetWindowIfNeeded(state, "UTC", new Date("2026-02-11T12:00:00.000Z"));

    expect(state.notifications["daily:warning"]).toBeNull();
    expect(state.notifications["weekly:warning"]).toBeNull();
    expect(state.notifications["monthly:warning"]).toBeNull();
    expect(state.cachedCosts.daily.total).toBe(0);
    expect(state.cachedCosts.weekly.total).toBe(0);
    expect(state.cachedCosts.monthly.total).toBe(0);
  });

  it("updates last poll timestamp in ISO format", async () => {
    const mod = await import("../src/state-store.ts");
    const state = mod.loadState();
    mod.updateLastPoll(state, new Date("2026-02-11T12:00:00.000Z"));
    expect(state.lastPollAt).toContain("2026-02-11");
  });
});
