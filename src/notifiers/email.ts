import nodemailer from "nodemailer";
import type { Alert, Notifier, NotificationConfig } from "./types.js";
import { formatWindowLabel } from "./window-label.js";

export class EmailNotifier implements Notifier {
  name = "email";
  private enabled: boolean;
  private transport?: nodemailer.Transporter;
  private from?: string;
  private to?: string;

  constructor(config: NotificationConfig) {
    this.enabled = config.notifications.email.enabled;
    if (!this.enabled) {
      return;
    }
    const email = config.notifications.email;
    if (!email.smtp_host || !email.smtp_port || !email.smtp_user || !email.smtp_pass || !email.from || !email.to) {
      this.enabled = false;
      return;
    }
    this.transport = nodemailer.createTransport({
      host: email.smtp_host,
      port: email.smtp_port,
      secure: email.smtp_secure,
      auth: {
        user: email.smtp_user,
        pass: email.smtp_pass,
      },
    });
    this.from = email.from;
    this.to = email.to;
  }

  async send(alert: Alert): Promise<void> {
    if (!this.enabled || !this.transport || !this.from || !this.to) {
      return;
    }

    const label = alert.transition === "recovery" ? "RECOVERY" : alert.level === "critical" ? "CRITICAL" : "WARNING";
    const subject = `[${label}] Claude Cost ${formatWindowLabel(alert.window)} ${alert.transition === "recovery" ? "recovered" : "threshold exceeded"}`;
    const text = `${label} ${formatWindowLabel(alert.window)} ${alert.transition === "recovery" ? "cost recovered." : "cost exceeded."}

Current cost: $${alert.currentCost.toFixed(2)}
Threshold: $${alert.threshold.toFixed(2)}
Time: ${alert.timestamp.toISOString()}
`;

    await this.transport.sendMail({
      from: this.from,
      to: this.to.split(",").map((entry) => entry.trim()),
      subject,
      text,
      headers: alert.idempotencyKey ? { "X-Cceye-Idempotency-Key": alert.idempotencyKey } : undefined,
    });
  }
}
