import chalk from "chalk";
import type { Alert, Notifier } from "./types.js";
import { formatWindowLabel } from "./window-label.js";

export class ConsoleNotifier implements Notifier {
  name = "console";

  async send(alert: Alert): Promise<void> {
    const time = alert.timestamp.toISOString().replace("T", " ").split(".")[0];
    const label = alert.transition === "recovery" ? "RECOVERY" : alert.level === "critical" ? "CRITICAL" : "WARNING";
    const message = alert.transition === "recovery"
      ? `[${time}] [${label}] ${formatWindowLabel(alert.window)} cost recovered: $${alert.currentCost.toFixed(2)}`
      : `[${time}] [${label}] ${formatWindowLabel(alert.window)} cost exceeded: $${alert.currentCost.toFixed(2)} / threshold $${alert.threshold.toFixed(2)}`;
    const output = alert.transition === "recovery" ? chalk.green(message) : alert.level === "critical" ? chalk.red(message) : chalk.yellow(message);
    console.log(output);
  }
}
