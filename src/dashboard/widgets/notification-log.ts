import type { NotificationHistoryEntry } from "../../data-store.js";
import type { LogWidget } from "../widget-types.js";

export function updateNotificationLog(log: LogWidget, entries: NotificationHistoryEntry[]): void {
  log.setContent("");
  let lastDate = "";
  entries
    .slice(0, 30)
    .reverse()
    .forEach((entry) => {
      const date = entry.timestamp.split("T")[0] ?? "";
      if (date && date !== lastDate) {
        log.log(date);
        lastDate = date;
      }
      const time = entry.timestamp.split("T")[1]?.split(".")[0]?.slice(0, 5) ?? "";
      const label = entry.level === "critical" ? "CRIT" : "WARN";
      const windowLabel = entry.window === "daily" ? "Daily" : entry.window === "weekly" ? "Weekly" : "Monthly";
      log.log(`${time} [${label}] ${windowLabel} $${entry.currentCost.toFixed(2)}`);
    });
}
