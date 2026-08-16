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
  totalCost: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  byModel: Record<string, number | null>;
  byProject: Record<string, number | null>;
  bySession?: Record<string, number | null> | undefined;
  totalEvents: number;
  pricedEvents: number;
  totalInputTokens: number;
  pricedInputTokens: number;
}

export interface ReportRow {
  key: string;
  totalCost: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  byModel: Record<string, number | null>;
  byProject: Record<string, number | null>;
  bySession?: Record<string, number | null> | undefined;
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
    totalEvents: 0,
    pricedEvents: 0,
    totalInputTokens: 0,
    pricedInputTokens: 0,
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
    bucket.totalCost = addNullableCost(bucket.totalCost, entry.costUSD);
    bucket.totalEvents += 1;
    bucket.pricedEvents += entry.costUSD === null ? 0 : 1;
    bucket.totalInputTokens += entry.inputTokens;
    bucket.pricedInputTokens += entry.costUSD === null ? 0 : entry.inputTokens;
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.cacheCreationTokens += entry.cacheCreationTokens;
    bucket.cacheReadTokens += entry.cacheReadTokens;
    addBreakdownCost(bucket.byModel, entry.model, entry.costUSD);
    addBreakdownCost(bucket.byProject, project, entry.costUSD);
    const session = entry.session ?? "unknown";
    if (!bucket.bySession) {
      bucket.bySession = {};
    }
    addBreakdownCost(bucket.bySession, `${project}/${session}`, entry.costUSD);
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
      coverage: {
        eventCoverageRatio: bucket.totalEvents === 0 ? 1 : bucket.pricedEvents / bucket.totalEvents,
        tokenCoverageRatio: bucket.totalInputTokens === 0 ? 1 : bucket.pricedInputTokens / bucket.totalInputTokens,
        unpricedEvents: bucket.totalEvents - bucket.pricedEvents,
        complete: bucket.totalEvents === bucket.pricedEvents,
      },
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

export async function buildSessionReportRowsFromStorage(
  storage: UsageStorage,
  options: ReportOptions,
  basis: CostBasis
): Promise<ReportRow[]> {
  const now = new Date();
  const from = options.since
    ? compactDateToUtc(options.since, options.timezone)
    : new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000);
  const until = options.until
    ? addDays(compactDateToUtc(options.until, options.timezone), 1)
    : new Date(now.getTime() + 1);
  const summary = await storage.queryUsage({ fromMs: from.getTime(), untilMs: until.getTime(), basis });

  return summary.bySession
    .filter((session) => session.events > 0)
    .map((session) => {
      const project = session.key.split("/")[0] ?? "unknown";
      const pricedEvents = session.events - session.unpricedEvents;
      const amountNanos = session.amountNanos?.toString() ?? null;
      const amount = nanosToNumber(session.amountNanos);
      return {
        key: session.key,
        totalCost: amount,
        inputTokens: session.inputTokens ?? 0,
        outputTokens: session.outputTokens ?? 0,
        cacheCreationTokens: session.cacheCreationTokens ?? 0,
        cacheReadTokens: session.cacheReadTokens ?? 0,
        byModel: {},
        byProject: { [project]: amount },
        bySession: { [session.key]: amount },
        amountNanos,
        coverage: {
          eventCoverageRatio: session.events === 0 ? 1 : pricedEvents / session.events,
          tokenCoverageRatio:
            (session.inputTokens ?? 0) === 0 ? 1 : (session.pricedInputTokens ?? 0) / (session.inputTokens ?? 0),
          unpricedEvents: session.unpricedEvents,
          complete: session.unpricedEvents === 0,
        },
      } satisfies ReportRow;
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function formatBreakdown(values: Record<string, number | null>, options: ReportOptions): string {
  const sorted = Object.entries(values).sort(([, a], [, b]) => (b ?? -1) - (a ?? -1));
  const top = options.top && options.top > 0 ? sorted.slice(0, options.top) : sorted;
  if (options.other && top.length < sorted.length) {
    const other = sorted.slice(top.length).reduce<number | null>(
      (sum, [, cost]) => addNullableCost(sum, cost),
      0
    );
    top.push(["Other", other]);
  }
  return top
    .sort(([, a], [, b]) => (b ?? -1) - (a ?? -1))
    .map(([model, cost]) => `${model}=${cost === null ? "UNPRICED" : `$${cost.toFixed(4)}`}`)
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
    const cost = row.totalCost === null ? "UNPRICED" : `$${row.totalCost.toFixed(4)}`;
    const base = `${row.key} cost=${cost} input=${row.inputTokens} output=${row.outputTokens} cacheCreate=${row.cacheCreationTokens} cacheRead=${row.cacheReadTokens}`;
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

const nanosToNumber = (amount: bigint | null): number | null => (amount === null ? null : Number(amount) / 1_000_000_000);

const addNullableCost = (current: number | null, amount: number | null): number | null => {
  if (current === null || amount === null) {
    return null;
  }
  return current + amount;
};

const addBreakdownCost = (breakdown: Record<string, number | null>, key: string, amount: number | null): void => {
  const current = Object.prototype.hasOwnProperty.call(breakdown, key) ? breakdown[key]! : 0;
  breakdown[key] = addNullableCost(current, amount);
};
