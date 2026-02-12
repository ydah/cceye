import type { Config } from "./config.js";

export interface ThresholdResult {
  window: "daily" | "weekly" | "monthly";
  level: "warning" | "critical" | null;
  currentCost: number;
  threshold: number | null;
}

export function evaluateThresholds(
  costs: { daily: number; weekly: number; monthly: number },
  thresholds: Config["thresholds"]
): ThresholdResult[] {
  const windows: Array<"daily" | "weekly" | "monthly"> = ["daily", "weekly", "monthly"];
  const results: ThresholdResult[] = [];

  for (const window of windows) {
    const cost = costs[window];
    const { warning, critical } = thresholds[window];
    if (cost >= critical) {
      results.push({
        window,
        level: "critical",
        currentCost: cost,
        threshold: critical,
      });
      continue;
    }
    if (cost >= warning) {
      results.push({
        window,
        level: "warning",
        currentCost: cost,
        threshold: warning,
      });
    }
  }

  return results;
}
