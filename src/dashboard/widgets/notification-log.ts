import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { NotificationHistoryEntry } from "../../data-store.js";
import type { LogWidget } from "../widget-types.js";

function formatNotificationTimestamp(
  timestamp: string,
  timezone: string
): { date: string; time: string } | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const zoned = toZonedTime(parsed, timezone);
  return {
    date: format(zoned, "yyyy-MM-dd"),
    time: format(zoned, "HH:mm"),
  };
}

export function updateNotificationLog(log: LogWidget, entries: NotificationHistoryEntry[], timezone: string): void {
  log.setContent("");
  let lastDate = "";
  entries
    .slice(0, 30)
    .reverse()
    .forEach((entry) => {
      const formattedTimestamp = formatNotificationTimestamp(entry.timestamp, timezone);
      if (!formattedTimestamp) {
        return;
      }

      if (formattedTimestamp.date !== lastDate) {
        log.log(formattedTimestamp.date);
        lastDate = formattedTimestamp.date;
      }
      const label = entry.level === "critical" ? "CRIT" : "WARN";
      const windowLabel = entry.window === "daily" ? "Daily" : entry.window === "weekly" ? "Weekly" : "Monthly";
      log.log(`${formattedTimestamp.time} [${label}] ${windowLabel} $${entry.currentCost.toFixed(2)}`);
    });
}
