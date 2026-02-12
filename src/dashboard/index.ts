import { createLayout } from "./layout.js";
import { renderCostProgress } from "./widgets/cost-progress.js";
import { updateHourlyTrend } from "./widgets/hourly-trend.js";
import { updateModelBreakdown } from "./widgets/model-breakdown.js";
import { updateNotificationLog } from "./widgets/notification-log.js";
import { updateStatusBar } from "./widgets/status-bar.js";
import type { DataStoreState } from "../data-store.js";
import type { Config } from "../config.js";

type DashboardConfig = Pick<Config, "thresholds">;

export class Dashboard {
  private layout = createLayout();
  private selectedWindow: "daily" | "weekly" | "monthly" = "daily";
  private destroyed = false;

  constructor() {
    this.registerKeys();
  }

  onQuit(callback: () => void): void {
    this.layout.screen.key(["q", "C-c"], () => {
      callback();
    });
  }

  onRefresh(callback: () => void): void {
    this.layout.screen.key(["r"], () => {
      callback();
    });
  }

  onWindowChange(callback: (window: "daily" | "weekly" | "monthly") => void): void {
    this.layout.screen.key(["d", "w", "m"], (_, key) => {
      const selected = key.name === "d" ? "daily" : key.name === "w" ? "weekly" : "monthly";
      this.selectedWindow = selected;
      callback(selected);
    });
  }

  update(
    data: DataStoreState,
    config: DashboardConfig,
    lastUpdated: Date | null,
    nextPoll: Date | null,
    statusMessage?: string
  ): void {
    renderCostProgress(this.layout.costBox, data.currentCosts, config);
    updateHourlyTrend(this.layout.trendLine, data.hourlyTrend);
    updateModelBreakdown(this.layout.modelTable, data.modelBreakdown[this.selectedWindow]);
    updateNotificationLog(this.layout.notificationLog, data.notificationHistory);
    updateStatusBar(this.layout.statusBar, lastUpdated, nextPoll, statusMessage);
    this.layout.screen.render();
  }

  focusNext(): void {
    const focusables = [this.layout.costBox, this.layout.trendLine, this.layout.modelTable, this.layout.notificationLog];
    const currentIndex = focusables.findIndex((widget) => widget === this.layout.screen.focused);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % focusables.length : 0;
    focusables[nextIndex]?.focus();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.layout.screen.destroy();
  }

  private registerKeys(): void {
    this.layout.screen.key(["tab"], () => {
      this.focusNext();
    });
    this.layout.screen.key(["up"], () => {
      this.layout.notificationLog.scroll(-1);
    });
    this.layout.screen.key(["down"], () => {
      this.layout.notificationLog.scroll(1);
    });
    this.layout.screen.on("resize", () => {
      this.layout.screen.render();
    });
  }
}
