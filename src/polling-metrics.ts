import type { ModelCost, ProjectCost, TrendPoint } from "./data-store.js";
import type { UsageEntry } from "./log-parser.js";

export function toModelBreakdown(byModel: Record<string, number | null>): ModelCost[] {
  return Object.entries(byModel).map(([model, cost]) => ({ model, cost }));
}

export function toProjectBreakdown(byProject: Record<string, number | null>): ProjectCost[] {
  return Object.entries(byProject).map(([project, cost]) => ({ project, cost }));
}

export function hourlyTrend(entries: UsageEntry[]): TrendPoint[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const buckets = new Map<string, number>();
  const unpricedBuckets = new Set<string>();

  for (const entry of entries) {
    const timestamp = entry.timestamp.getTime();
    if (timestamp < cutoff) {
      continue;
    }
    const hour = new Date(entry.timestamp);
    hour.setMinutes(0, 0, 0);
    const key = hour.toISOString();
    if (entry.costUSD === null) {
      unpricedBuckets.add(key);
      continue;
    }
    buckets.set(key, (buckets.get(key) ?? 0) + entry.costUSD);
  }

  return Array.from(buckets.entries())
    .filter(([hour]) => !unpricedBuckets.has(hour))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, cost]) => ({ hour, cost }));
}

export function nextPoll(intervalMilliseconds: number): Date {
  return new Date(Date.now() + intervalMilliseconds);
}
