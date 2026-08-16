import crypto from "crypto";
import { fetchCostReport } from "../cost-fetcher.js";
import { decimalToNanos } from "../money.js";
import type { BillingRecord, UsageStorage } from "../storage/storage.js";
import type { BillingConfig, BillingSyncResult } from "./types.js";

export const syncAnthropicBilling = async (
  config: BillingConfig,
  storage: UsageStorage,
  from: Date,
  until: Date
): Promise<BillingSyncResult> => {
  if (!config.enabled) {
    throw new Error("billing is disabled");
  }
  const apiKey = process.env[config.api_key_env];
  if (!apiKey) {
    throw new Error(`billing authentication failed: ${config.api_key_env} is not set`);
  }
  const fetchedAtMs = Date.now();
  const report = await fetchCostReport(apiKey, from, until, "1d", { groupByDescription: true });
  const records = report.data.flatMap((bucket) => {
    const periodStartMs = parseTimestamp(bucket.starting_at);
    const periodEndMs = parseTimestamp(bucket.ending_at);
    if (periodStartMs === null || periodEndMs === null) {
      return [];
    }
    return bucket.results.flatMap((result) => {
      try {
        const amountNanos = decimalToNanos(result.amount);
        const dimensions = Object.fromEntries(
          Object.entries({ description: result.description, cost_type: result.cost_type, model: result.model }).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        );
        const record: BillingRecord = {
          recordId: stableRecordId(periodStartMs, periodEndMs, result.currency ?? "USD", dimensions, amountNanos),
          provider: "anthropic",
          periodStartMs,
          periodEndMs,
          amountNanos,
          currency: result.currency ?? "USD",
          dimensions,
          fetchedAtMs,
        };
        return [record];
      } catch {
        return [];
      }
    });
  });
  for (const record of records) {
    await storage.upsertBillingRecord(record);
  }
  return { records, fetchedAtMs };
};

const parseTimestamp = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const stableRecordId = (
  periodStartMs: number,
  periodEndMs: number,
  currency: string,
  dimensions: Record<string, string>,
  amountNanos: bigint
): string =>
  crypto
    .createHash("sha256")
    .update(`anthropic\0${periodStartMs}\0${periodEndMs}\0${currency}\0${JSON.stringify(dimensions)}\0${amountNanos}`)
    .digest("hex");
