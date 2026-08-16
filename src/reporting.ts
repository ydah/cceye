import { addDays, addMonths, addWeeks, format, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { UsageEntry } from "./log-parser.js";
import type { CostBasis, UsageStorage } from "./storage/storage.js";

export type ReportCommand = "daily" | "weekly" | "monthly" | "session";

export interface ReportOptions {
  since?: string;
  until?: string;
  json: boolean;
  breakdown: boolean;
  timezone: string;
  breakdownDimension?: "model" | "project" | "session";
  showCoverage?: boolean;
  top?: number;
  other?: boolean;
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
  bySession?: Record<string, number> | undefined;
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
  bySession?: Record<string, number> | undefined;
  amountNanos?: string | null;
  coverage?: {
    eventCoverageRatio: number;
    tokenCoverageRatio: number;
    unpricedEvents: number;
    complete: boolean;
  };
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
    const session = entry.session ?? "unknown";
    if (!bucket.bySession) {
      bucket.bySession = {};
    }
    bucket.bySession[`${project}/${session}`] = (bucket.bySession[`${project}/${session}`] ?? 0) + (entry.costUSD ?? 0);
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
      ...(bucket.bySession ? { bySession: bucket.bySession } : {}),
    }));
}

export async function buildReportRowsFromStorage(
  storage: UsageStorage,
  command: Exclude<ReportCommand, "session">,
  options: ReportOptions,
  basis: CostBasis
): Promise<ReportRow[]> {
  const now = new Date();
  const from = options.since ? compactDateToUtc(options.since, options.timezone) : new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
  const until = options.until ? addDays(compactDateToUtc(options.until, options.timezone), 1) : new Date(now.getTime() + 1);
  const rows: ReportRow[] = [];
  let cursor = startOfDay(toZonedTime(from, options.timezone));
  while (fromZonedTime(cursor, options.timezone).getTime() < until.getTime()) {
    const periodStart = command === "daily" ? startOfDay(cursor) : command === "weekly" ? startOfWeek(cursor, { weekStartsOn: 1 }) : startOfMonth(cursor);
    const periodEnd = command === "daily" ? addDays(periodStart, 1) : command === "weekly" ? addWeeks(periodStart, 1) : addMonths(periodStart, 1);
    const fromMs = Math.max(from.getTime(), fromZonedTime(periodStart, options.timezone).getTime());
    const untilMs = Math.min(until.getTime(), fromZonedTime(periodEnd, options.timezone).getTime());
    if (fromMs < untilMs) {
      const summary = await storage.queryUsage({ fromMs, untilMs, basis });
      if (summary.events > 0) {
        rows.push({
          key: command === "monthly" ? format(periodStart, "yyyy-MM") : format(periodStart, "yyyy-MM-dd"),
          totalCost: nanosToNumber(summary.totalAmountNanos),
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          cacheCreationTokens: summary.cacheCreationTokens,
          cacheReadTokens: summary.cacheReadTokens,
          byModel: Object.fromEntries(summary.byModel.map((item) => [item.key, nanosToNumber(item.amountNanos)])),
          byProject: Object.fromEntries(summary.byProject.map((item) => [item.key, nanosToNumber(item.amountNanos)])),
          bySession: Object.fromEntries(summary.bySession.map((item) => [item.key, nanosToNumber(item.amountNanos)])),
          amountNanos: summary.totalAmountNanos?.toString() ?? null,
          coverage: {
            eventCoverageRatio: summary.coverage.eventCoverageRatio,
            tokenCoverageRatio: summary.coverage.tokenCoverageRatio,
            unpricedEvents: summary.coverage.unpricedEvents,
            complete: summary.coverage.complete,
          },
        });
      }
    }
    const nextCursor = command === "daily" ? addDays(periodStart, 1) : command === "weekly" ? addWeeks(periodStart, 1) : addMonths(periodStart, 1);
    if (nextCursor.getTime() <= cursor.getTime()) {
      break;
    }
    cursor = nextCursor;
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

function formatBreakdown(values: Record<string, number>, options: ReportOptions): string {
  const sorted = Object.entries(values).sort(([, a], [, b]) => b - a);
  const top = options.top && options.top > 0 ? sorted.slice(0, options.top) : sorted;
  if (options.other && top.length < sorted.length) {
    const other = sorted.slice(top.length).reduce((sum, [, cost]) => sum + cost, 0);
    top.push(["Other", other]);
  }
  return top
    .sort(([, a], [, b]) => b - a)
    .map(([model, cost]) => `${model}=$${cost.toFixed(4)}`)
    .join(", ");
}

export function printReportRows(rows: ReportRow[], options: ReportOptions): void {
  if (options.json) {
    console.log(JSON.stringify(rows.map((row) => ({ schemaVersion: 1, ...row })), null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No data.");
    return;
  }

  for (const row of rows) {
    const base = `${row.key} cost=$${row.totalCost.toFixed(4)} input=${row.inputTokens} output=${row.outputTokens} cacheCreate=${row.cacheCreationTokens} cacheRead=${row.cacheReadTokens}`;
    const coverage = options.showCoverage && row.coverage
      ? ` coverage=${row.coverage.complete ? "complete" : `PARTIAL (${row.coverage.unpricedEvents} unpriced)`} ${(row.coverage.eventCoverageRatio * 100).toFixed(1)}%`
      : "";
    if (!options.breakdown) {
      console.log(`${base}${coverage}`);
      continue;
    }
    const values = options.breakdownDimension === "project" ? row.byProject : options.breakdownDimension === "session" ? row.bySession ?? {} : row.byModel;
    const label = options.breakdownDimension ?? "model";
    const breakdown = formatBreakdown(values, options);
    console.log(`${base}${coverage} ${label}s=[${breakdown}]`);
  }
}

const compactDateToUtc = (value: string, timezone: string): Date => {
  const local = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  return fromZonedTime(local, timezone);
};

const nanosToNumber = (amount: bigint | null): number => (amount === null ? 0 : Number(amount) / 1_000_000_000);
