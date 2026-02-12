import type { Alert, Notifier, NotificationConfig } from "./types.js";
import { ConsoleNotifier } from "./console.js";
import { MacosNotifier } from "./macos.js";
import { SlackNotifier } from "./slack.js";
import { EmailNotifier } from "./email.js";

export class NotificationRouter {
  private notifiers: Notifier[];

  constructor(config: NotificationConfig, options?: { suppressConsole?: boolean }) {
    this.notifiers = [];
    if (config.notifications.console.enabled && !options?.suppressConsole) {
      this.notifiers.push(new ConsoleNotifier());
    }
    if (config.notifications.macos.enabled) {
      this.notifiers.push(new MacosNotifier(config));
    }
    if (config.notifications.slack.enabled) {
      this.notifiers.push(new SlackNotifier(config));
    }
    if (config.notifications.email.enabled) {
      this.notifiers.push(new EmailNotifier(config));
    }
  }

  async send(alert: Alert): Promise<string[]> {
    const results = await Promise.allSettled(this.notifiers.map((notifier) => notifier.send(alert)));
    const channels: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        channels.push(this.notifiers[index]?.name ?? "unknown");
      }
    });
    return channels;
  }
}
