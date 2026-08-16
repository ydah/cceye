import { theme } from "../theme.js";
import type { Config } from "../../config.js";
import type { CostCoverage } from "../../storage/storage.js";

interface CostProgressData {
  daily: number;
  weekly: number;
  monthly: number;
}

export function renderCostProgress(
  box: { setContent(value: string): void },
  costs: CostProgressData,
  config: Pick<Config, "thresholds">,
  coverage?: Partial<Record<"daily" | "weekly" | "monthly", CostCoverage>>
): void {
  const lines = [
    renderLine("Daily", costs.daily, config.thresholds.daily.warning, config.thresholds.daily.critical, coverage?.daily),
    renderLine("Weekly", costs.weekly, config.thresholds.weekly.warning, config.thresholds.weekly.critical, coverage?.weekly),
    renderLine("Monthly", costs.monthly, config.thresholds.monthly.warning, config.thresholds.monthly.critical, coverage?.monthly),
  ];
  box.setContent(lines.join("\n\n"));
}

function renderLine(label: string, cost: number, warning: number, critical: number, coverage?: CostCoverage): string {
  const ratio = critical > 0 ? Math.min(cost / critical, 1) : 0;
  const barLength = 20;
  const filled = Math.round(barLength * ratio);
  const empty = barLength - filled;
  const bar = `${"#".repeat(filled)}${"-".repeat(empty)}`;
  const percent = critical > 0 ? (cost / critical) * 100 : 0;
  const color = cost >= critical ? theme.colors.critical : cost >= warning ? theme.colors.warning : theme.colors.ok;
  const quality = coverage && !coverage.complete ? ` PARTIAL (${coverage.unpricedEvents} unpriced)` : "";
  return `{${color}-fg}${label.padEnd(7)} ${bar}{/${color}-fg} $${cost.toFixed(2)} / $${critical.toFixed(
    2
  )} (${percent.toFixed(1)}%)${quality}`;
}
