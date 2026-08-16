import type { Alert, Notifier, NotificationConfig } from "./types.js";
import { formatWindowLabel } from "./window-label.js";

const levelColors: Record<Alert["level"], string> = {
  warning: "#f2c744",
  critical: "#e01e5a",
};

export class SlackNotifier implements Notifier {
  name = "slack";
  private enabled: boolean;
  private webhookUrl: string | undefined;
  private mention: string;

  constructor(config: NotificationConfig) {
    this.enabled = config.notifications.slack.enabled;
    this.webhookUrl = config.notifications.slack.webhook_url;
    this.mention = config.notifications.slack.mention ?? "";
  }

  async send(alert: Alert): Promise<void> {
    if (!this.enabled || !this.webhookUrl) {
      return;
    }

    const label = alert.transition === "recovery" ? "RECOVERY" : alert.level === "critical" ? "CRITICAL" : "WARNING";
    const message = `${this.mention ? `${this.mention} ` : ""}${label} ${formatWindowLabel(
      alert.window
    )} ${alert.transition === "recovery" ? "cost recovered" : `cost exceeded: $${alert.currentCost.toFixed(2)} / $${alert.threshold.toFixed(2)}`}`;

    const payload = {
      attachments: [
        {
          color: alert.transition === "recovery" ? "#36a64f" : levelColors[alert.level],
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: message,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Time: ${alert.timestamp.toISOString()}`,
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(alert.idempotencyKey ? { "X-Cceye-Idempotency-Key": alert.idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`slack webhook request failed with status ${response.status}`);
    }
  }
}
