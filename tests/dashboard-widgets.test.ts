import { describe, expect, it, vi } from "vitest";
import { theme } from "../src/dashboard/theme.ts";
import { renderCostProgress } from "../src/dashboard/widgets/cost-progress.ts";
import { updateHourlyTrend } from "../src/dashboard/widgets/hourly-trend.ts";
import { updateModelBreakdown } from "../src/dashboard/widgets/model-breakdown.ts";
import { updateNotificationLog } from "../src/dashboard/widgets/notification-log.ts";
import { updateStatusBar } from "../src/dashboard/widgets/status-bar.ts";
import type { LineChartWidget, LogWidget, TableWidget } from "../src/dashboard/widget-types.ts";
import type { Config } from "../src/config.ts";

describe("dashboard theme and widgets", () => {
  it("exposes expected theme colors", () => {
    expect(theme.colors.ok).toBe("green");
    expect(theme.colors.critical).toBe("red");
  });

  it("renders cost progress content", () => {
    const box = { setContent: vi.fn() };
    const config: Pick<Config, "thresholds"> = {
      thresholds: {
        daily: { warning: 5, critical: 10 },
        weekly: { warning: 10, critical: 20 },
        monthly: { warning: 30, critical: 40 },
      },
    };
    renderCostProgress(
      box,
      { daily: 5, weekly: 15, monthly: 20 },
      config
    );
    expect(box.setContent).toHaveBeenCalledTimes(1);
    const content = String(box.setContent.mock.calls[0]?.[0]);
    expect(content).toContain("Daily");
    expect(content).toContain("$5.00");
  });

  it("updates hourly trend chart for empty and non-empty data", () => {
    const setData = vi.fn();
    const chart: LineChartWidget = { focus: vi.fn(), setData };
    updateHourlyTrend(chart, []);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0]?.[0][0].y).toEqual([0]);

    updateHourlyTrend(chart, [
      { hour: "2026-02-11T10:00:00.000Z", cost: 1.2 },
      { hour: "invalid", cost: 2.3 },
    ]);
    const payload = setData.mock.calls[1]?.[0][0];
    const expectedHour = String(new Date("2026-02-11T10:00:00.000Z").getHours()).padStart(2, "0");
    expect(payload.x).toEqual([expectedHour, ""]);
    expect(payload.y).toEqual([1.2, 2.3]);
  });

  it("updates model breakdown table sorted by cost", () => {
    const setData = vi.fn();
    const table: TableWidget = { focus: vi.fn(), setData };
    updateModelBreakdown(table, [
      { model: "low", cost: 1 },
      { model: "high", cost: 3 },
    ]);

    const arg = setData.mock.calls[0]?.[0];
    expect(arg.headers).toEqual(["Model", "Cost", "%"]);
    expect(arg.data[0]).toEqual(["high", "$3.00", "75%"]);

    updateModelBreakdown(table, [
      { model: "zero-a", cost: 0 },
      { model: "zero-b", cost: 0 },
    ]);
    const zeroArg = setData.mock.calls[1]?.[0];
    expect(zeroArg.data[0][2]).toBe("0%");
    expect(zeroArg.data[1][2]).toBe("0%");
  });

  it("updates notification log with timezone-aware date and time", () => {
    const setContent = vi.fn();
    const writeLog = vi.fn();
    const log: LogWidget = { focus: vi.fn(), setContent, log: writeLog, scroll: vi.fn() };
    updateNotificationLog(
      log,
      [
        {
          timestamp: "2026-02-11T10:00:00.000Z",
          level: "warning",
          window: "daily",
          currentCost: 1.2,
          threshold: 1,
          channels: [],
        },
        {
          timestamp: "2026-02-11T11:00:00.000Z",
          level: "critical",
          window: "weekly",
          currentCost: 2.3,
          threshold: 2,
          channels: [],
        },
      ],
      "Asia/Tokyo"
    );
    expect(setContent).toHaveBeenCalledWith("");
    expect(writeLog).toHaveBeenCalled();
    const logs = writeLog.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logs.length).toBe(2);
    expect(logs.some((line) => line.includes("[CRIT]"))).toBe(true);
    expect(logs.some((line) => line.includes("2026-02-11 19:00 [WARN] Daily $1.20"))).toBe(true);
    expect(logs.some((line) => line.includes("2026-02-11 20:00 [CRIT] Weekly $2.30"))).toBe(true);
  });

  it("updates status bar text", () => {
    const bar = { setContent: vi.fn() };
    updateStatusBar(
      bar,
      new Date("2026-02-11T10:00:00.000Z"),
      new Date("2026-02-11T10:05:00.000Z"),
      "Fetching..."
    );
    const content = String(bar.setContent.mock.calls[0]?.[0]);
    expect(content).toContain("Last updated");
    expect(content).toContain("Fetching...");

    updateStatusBar(bar, null, null);
    const fallback = String(bar.setContent.mock.calls[1]?.[0]);
    expect(fallback).toContain("--:--:--");
    expect(fallback).not.toContain("Fetching...");
  });
});
