import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";

describe("Dashboard class", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers handlers and updates widgets", async () => {
    const keyHandlers: Array<{ keys: string[]; handler: (...args: unknown[]) => void }> = [];
    const resizeHandlers: Array<() => void> = [];
    const key = vi.fn((keys: string[], handler: (...args: unknown[]) => void) => {
      keyHandlers.push({ keys, handler });
    });
    const on = vi.fn((event: string, handler: () => void) => {
      if (event === "resize") {
        resizeHandlers.push(handler);
      }
    });
    const layout = {
      screen: {
        key,
        on,
        render: vi.fn(),
        focused: null as unknown,
        destroy: vi.fn(),
      },
      costBox: { focus: vi.fn() },
      trendLine: { focus: vi.fn() },
      modelTable: { focus: vi.fn() },
      notificationLog: { focus: vi.fn(), scroll: vi.fn() },
      statusBar: {},
    };

    const renderCostProgress = vi.fn();
    const updateHourlyTrend = vi.fn();
    const updateModelBreakdown = vi.fn();
    const updateNotificationLog = vi.fn();
    const updateStatusBar = vi.fn();

    const config: Pick<Config, "thresholds" | "timezone"> = {
      thresholds: {
        daily: { warning: 5, critical: 10 },
        weekly: { warning: 10, critical: 20 },
        monthly: { warning: 30, critical: 40 },
      },
      timezone: "Asia/Tokyo",
    };

    vi.doMock("../src/dashboard/layout.ts", () => ({ createLayout: () => layout }));
    vi.doMock("../src/dashboard/widgets/cost-progress.ts", () => ({ renderCostProgress }));
    vi.doMock("../src/dashboard/widgets/hourly-trend.ts", () => ({ updateHourlyTrend }));
    vi.doMock("../src/dashboard/widgets/model-breakdown.ts", () => ({ updateModelBreakdown }));
    vi.doMock("../src/dashboard/widgets/notification-log.ts", () => ({ updateNotificationLog }));
    vi.doMock("../src/dashboard/widgets/status-bar.ts", () => ({ updateStatusBar }));

    const { Dashboard } = await import("../src/dashboard/index.ts");
    const dashboard = new Dashboard();

    const onQuit = vi.fn();
    dashboard.onQuit(onQuit);
    keyHandlers.find((entry) => entry.keys.includes("q"))?.handler();
    expect(onQuit).toHaveBeenCalledTimes(1);

    const onRefresh = vi.fn();
    dashboard.onRefresh(onRefresh);
    keyHandlers.find((entry) => entry.keys.includes("r"))?.handler();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const onWindowChange = vi.fn();
    dashboard.onWindowChange(onWindowChange);
    const windowHandler = keyHandlers.find((entry) => entry.keys.includes("w"))?.handler;
    windowHandler?.(null, { name: "w" });
    windowHandler?.(null, { name: "d" });
    windowHandler?.(null, { name: "m" });
    expect(onWindowChange).toHaveBeenCalledWith("weekly");
    expect(onWindowChange).toHaveBeenCalledWith("daily");
    expect(onWindowChange).toHaveBeenCalledWith("monthly");

    layout.screen.focused = layout.costBox;
    keyHandlers.find((entry) => entry.keys.includes("tab"))?.handler();
    expect(layout.trendLine.focus).toHaveBeenCalledTimes(1);
    layout.screen.focused = null;
    keyHandlers.find((entry) => entry.keys.includes("tab"))?.handler();
    expect(layout.costBox.focus).toHaveBeenCalledTimes(1);

    keyHandlers.find((entry) => entry.keys.includes("up"))?.handler();
    keyHandlers.find((entry) => entry.keys.includes("down"))?.handler();
    expect(layout.notificationLog.scroll).toHaveBeenCalledWith(-1);
    expect(layout.notificationLog.scroll).toHaveBeenCalledWith(1);

    resizeHandlers[0]?.();
    expect(layout.screen.render).toHaveBeenCalledTimes(1);

    dashboard.update(
      {
        currentCosts: { daily: 1, weekly: 2, monthly: 3 },
        modelBreakdown: { daily: [], weekly: [{ model: "w", cost: 1 }], monthly: [{ model: "m", cost: 2 }] },
        hourlyTrend: [],
        notificationHistory: [],
        lastUpdated: null,
      },
      config,
      new Date("2026-02-11T10:00:00.000Z"),
      new Date("2026-02-11T10:05:00.000Z"),
      "ok"
    );

    expect(renderCostProgress).toHaveBeenCalledTimes(1);
    expect(updateHourlyTrend).toHaveBeenCalledTimes(1);
    expect(updateModelBreakdown).toHaveBeenCalledWith(layout.modelTable, [{ model: "m", cost: 2 }]);
    expect(updateNotificationLog).toHaveBeenCalledWith(layout.notificationLog, [], "Asia/Tokyo");
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(layout.screen.render).toHaveBeenCalledTimes(2);

    dashboard.destroy();
    dashboard.destroy();
    expect(layout.screen.destroy).toHaveBeenCalledTimes(1);
  });
});
