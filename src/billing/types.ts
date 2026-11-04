import type { BillingRecord, MoneyNanos, UsageSummary } from "../storage/storage.js";

export interface BillingConfig {
  enabled: boolean;
  api_key_env: string;
}

export interface BillingSyncResult {
  records: BillingRecord[];
  fetchedAtMs: number;
}

export interface ReconciliationResult {
  fromMs: number;
  untilMs: number;
  localReportedNanos: MoneyNanos | null;
  localEstimatedNanos: MoneyNanos | null;
  providerBilledNanos: MoneyNanos;
  estimatedCoverage: UsageSummary["coverage"];
  unpricedEvents: number;
  differenceNanos: MoneyNanos | null;
  differenceRatio: number | null;
}
