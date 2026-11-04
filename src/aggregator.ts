import { startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { UsageEntry } from "./log-parser.js";

export interface AggregatedCost {
  total: number | null;
  byModel: Record<string, number | null>;
  byProject: Record<string, number | null>;
  tokenBreakdown: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
}

export function periodRange(
  period: "daily" | "weekly" | "monthly",
  timezone: string,
  now = new Date()
): { fromMs: number; untilMs: number } {
  const zonedNow = toZonedTime(now, timezone);
  const startLocal =
    period === "daily"
      ? startOfDay(zonedNow)
      : period === "weekly"
        ? startOfWeek(zonedNow, { weekStartsOn: 1 })
        : startOfMonth(zonedNow);
  return { fromMs: fromZonedTime(startLocal, timezone).getTime(), untilMs: now.getTime() + 1 };
}

export function aggregateByPeriod(
  entries: UsageEntry[],
  period: "daily" | "weekly" | "monthly",
  timezone: string
): AggregatedCost {
  const now = new Date();
  const zonedNow = toZonedTime(now, timezone);

  let startLocal: Date;
  if (period === "daily") {
    startLocal = startOfDay(zonedNow);
  } else if (period === "weekly") {
    startLocal = startOfWeek(zonedNow, { weekStartsOn: 1 });
  } else {
    startLocal = startOfMonth(zonedNow);
  }

  const startUtc = fromZonedTime(startLocal, timezone);

  const result: AggregatedCost = {
    total: 0,
    byModel: {},
    byProject: {},
    tokenBreakdown: {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    },
  };

  for (const entry of entries) {
    if (entry.timestamp < startUtc || entry.timestamp > now) {
      continue;
    }
    const cost = entry.costUSD;
    result.byModel[entry.model] = addNullableCost(
      Object.prototype.hasOwnProperty.call(result.byModel, entry.model) ? result.byModel[entry.model]! : 0,
      cost
    );
    const project = entry.project ?? "unknown";
    result.byProject[project] = addNullableCost(
      Object.prototype.hasOwnProperty.call(result.byProject, project) ? result.byProject[project]! : 0,
      cost
    );
    result.total = addNullableCost(result.total, cost);
    result.tokenBreakdown.input += entry.inputTokens;
    result.tokenBreakdown.output += entry.outputTokens;
    result.tokenBreakdown.cacheCreation += entry.cacheCreationTokens;
    result.tokenBreakdown.cacheRead += entry.cacheReadTokens;
  }

  return result;
}

function addNullableCost(current: number | null, amount: number | null): number | null {
  if (current === null || amount === null) {
    return null;
  }
  return current + amount;
}
