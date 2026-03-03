import { format, startOfWeek } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import type { UsageEntry } from "./log-parser.js";

export type ReportCommand = "daily" | "weekly" | "monthly" | "session";

export interface ReportOptions {
  since?: string;
  until?: string;
  json: boolean;
  breakdown: boolean;
  timezone: string;
}

interface MutableBucket {
  key: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
}

export interface ReportRow {
  key: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
}

function toFilterKey(entry: UsageEntry, timezone: string): string {
  return format(toZonedTime(entry.timestamp, timezone), "yyyyMMdd");
}

function inRange(entry: UsageEntry, since: string | undefined, until: string | undefined, timezone: string): boolean {
  const key = toFilterKey(entry, timezone);
  if (since && key < since) {
    return false;
  }
  if (until && key > until) {
    return false;
  }
  return true;
}

function bucketKey(entry: UsageEntry, command: ReportCommand, timezone: string): string {
  const zoned = toZonedTime(entry.timestamp, timezone);
  if (command === "daily") {
    return format(zoned, "yyyy-MM-dd");
  }
  if (command === "weekly") {
    return format(startOfWeek(zoned, { weekStartsOn: 1 }), "yyyy-MM-dd");
  }
  if (command === "monthly") {
    return format(zoned, "yyyy-MM");
  }
  const project = entry.project ?? "unknown";
  const session = entry.session ?? "unknown";
  return `${project}/${session}`;
}

function createMutableBucket(key: string): MutableBucket {
  return {
    key,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    byModel: {},
    byProject: {},
  };
}

export function buildReportRows(entries: UsageEntry[], command: ReportCommand, options: ReportOptions): ReportRow[] {
  const buckets = new Map<string, MutableBucket>();

  for (const entry of entries) {
    if (!inRange(entry, options.since, options.until, options.timezone)) {
      continue;
    }
    const key = bucketKey(entry, command, options.timezone);
    const bucket = buckets.get(key) ?? createMutableBucket(key);
    const project = entry.project ?? "unknown";
    bucket.totalCost += entry.costUSD ?? 0;
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.cacheCreationTokens += entry.cacheCreationTokens;
    bucket.cacheReadTokens += entry.cacheReadTokens;
    bucket.byModel[entry.model] = (bucket.byModel[entry.model] ?? 0) + (entry.costUSD ?? 0);
    bucket.byProject[project] = (bucket.byProject[project] ?? 0) + (entry.costUSD ?? 0);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((bucket) => ({
      key: bucket.key,
      totalCost: bucket.totalCost,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: bucket.cacheCreationTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      byModel: bucket.byModel,
      byProject: bucket.byProject,
    }));
}

function formatBreakdown(byModel: Record<string, number>): string {
  return Object.entries(byModel)
    .sort(([, a], [, b]) => b - a)
    .map(([model, cost]) => `${model}=$${cost.toFixed(4)}`)
    .join(", ");
}

export function printReportRows(rows: ReportRow[], options: ReportOptions): void {
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No data.");
    return;
  }

  for (const row of rows) {
    const base = `${row.key} cost=$${row.totalCost.toFixed(4)} input=${row.inputTokens} output=${row.outputTokens} cacheCreate=${row.cacheCreationTokens} cacheRead=${row.cacheReadTokens}`;
    if (!options.breakdown) {
      console.log(base);
      continue;
    }
    const breakdown = formatBreakdown(row.byModel);
    console.log(`${base} models=[${breakdown}]`);
  }
}
