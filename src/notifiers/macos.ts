import { exec } from "child_process";
import type { Alert, Notifier, NotificationConfig } from "./types.js";
import { formatWindowLabel } from "./window-label.js";

export class MacosNotifier implements Notifier {
  name = "macos";
  private enabled: boolean;
  private sound: boolean;

  constructor(config: NotificationConfig) {
    this.enabled = config.notifications.macos.enabled;
    this.sound = config.notifications.macos.sound;
    if (process.platform !== "darwin") {
      this.enabled = false;
    }
  }

  async send(alert: Alert): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const subtitle = alert.level === "critical" ? "CRITICAL" : "WARNING";
    const body = `${formatWindowLabel(alert.window)} cost: $${alert.currentCost.toFixed(2)} (threshold: $${alert.threshold.toFixed(
      2
    )})`;
    const sound = this.sound ? " sound name \"Funk\"" : "";
    const command = `osascript -e 'display notification "${body}" with title "Claude Code Eye" subtitle "${subtitle}"${sound}'`;
    await new Promise<void>((resolve, reject) => {
      exec(command, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
