import { execFile } from "child_process";
import notifier from "node-notifier";
import type { Alert, Notifier, NotificationConfig } from "./types.js";
import { formatWindowLabel } from "./window-label.js";

const NOTIFICATION_TITLE = "Claude Code Eye";
const NOTIFICATION_SOUND = "Funk";
type NotificationPayload = {
  title: string;
  subtitle: string;
  message: string;
  sound: string | false;
  wait: boolean;
};

type NotificationCenterClient = {
  notify(notification: NotificationPayload, callback: (error: Error | null) => void): void;
};

const JXA_NOTIFICATION_SCRIPT = [
  "function run(argv) {",
  "  const app = Application.currentApplication();",
  "  app.includeStandardAdditions = true;",
  "  const body = argv[0];",
  "  const subtitle = argv[1];",
  "  const shouldPlaySound = argv[2] === \"true\";",
  `  const options = { withTitle: "${NOTIFICATION_TITLE}", subtitle };`,
  "  if (shouldPlaySound) {",
  `    options.soundName = "${NOTIFICATION_SOUND}";`,
  "  }",
  "  app.displayNotification(body, options);",
  "}",
].join("\n");

export class MacosNotifier implements Notifier {
  name = "macos";
  private enabled: boolean;
  private sound: boolean;
  private notificationCenter: NotificationCenterClient | null;

  constructor(config: NotificationConfig) {
    this.enabled = config.notifications.macos.enabled;
    this.sound = config.notifications.macos.sound;
    this.notificationCenter = null;
    if (process.platform !== "darwin") {
      this.enabled = false;
      return;
    }
    this.notificationCenter = new notifier.NotificationCenter({ withFallback: false }) as NotificationCenterClient;
  }

  async send(alert: Alert): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const subtitle = alert.level === "critical" ? "CRITICAL" : "WARNING";
    const body = `${formatWindowLabel(alert.window)} cost: $${alert.currentCost.toFixed(2)} (threshold: $${alert.threshold.toFixed(
      2
    )})`;
    try {
      await this.sendWithNotificationCenter(body, subtitle);
      return;
    } catch (error) {
      if (!this.shouldFallbackToJxa(error)) {
        throw error;
      }
    }
    await this.sendWithJxa(body, subtitle);
  }

  private sendWithNotificationCenter(body: string, subtitle: string): Promise<void> {
    if (!this.notificationCenter) {
      return Promise.reject(new Error("macOS NotificationCenter is not initialized"));
    }
    const notificationCenter = this.notificationCenter;
    return new Promise<void>((resolve, reject) => {
      notificationCenter.notify(
        {
          title: NOTIFICATION_TITLE,
          subtitle,
          message: body,
          sound: this.sound ? NOTIFICATION_SOUND : false,
          wait: false,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
  }

  private sendWithJxa(body: string, subtitle: string): Promise<void> {
    const args = ["-l", "JavaScript", "-e", JXA_NOTIFICATION_SCRIPT, body, subtitle, this.sound ? "true" : "false"];
    return new Promise<void>((resolve, reject) => {
      execFile("osascript", args, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private shouldFallbackToJxa(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return true;
    }
    return /terminal-notifier/i.test(error.message);
  }
}
