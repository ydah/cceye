import type { Alert, DeliveryResult, Notifier, NotificationConfig } from "./types.js";
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

  async sendDetailed(alert: Alert): Promise<DeliveryResult[]> {
    const results = await Promise.allSettled(this.notifiers.map((notifier) => notifier.send(alert)));
    return results.map((result, index) => {
      const channel = this.notifiers[index]?.name ?? "unknown";
      if (result.status === "fulfilled") {
        return { channel, status: "success" };
      }
      return { channel, status: "failed", error: redactSecret(result.reason) };
    });
  }

  /**
   * Compatibility wrapper for callers that only need successful channel names.
   * New delivery-aware code should use sendDetailed.
   */
  async send(alert: Alert): Promise<string[]> {
    const results = await this.sendDetailed(alert);
    return results.filter((result) => result.status === "success").map((result) => result.channel);
  }
}

function redactSecret(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]");
}
