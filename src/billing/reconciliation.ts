import type { UsageStorage } from "../storage/storage.js";
import type { ReconciliationResult } from "./types.js";

export const reconcileUsage = async (
  storage: UsageStorage,
  fromMs: number,
  untilMs: number
): Promise<ReconciliationResult> => {
  const [reported, estimated, billing] = await Promise.all([
    storage.queryUsage({ fromMs, untilMs, basis: "reported" }),
    storage.queryUsage({ fromMs, untilMs, basis: "estimated" }),
    storage.queryBilling(fromMs, untilMs),
  ]);
  const providerBilledNanos = billing.reduce((total, record) => total + record.amountNanos, 0n);
  const localEstimatedNanos = estimated.totalAmountNanos;
  const differenceNanos = localEstimatedNanos === null ? null : localEstimatedNanos - providerBilledNanos;
  return {
    fromMs,
    untilMs,
    localReportedNanos: reported.totalAmountNanos,
    localEstimatedNanos,
    providerBilledNanos,
    estimatedCoverage: estimated.coverage,
    unpricedEvents: estimated.coverage.unpricedEvents,
    differenceNanos,
    differenceRatio:
      differenceNanos === null || providerBilledNanos === 0n
        ? null
        : Number(differenceNanos) / Number(providerBilledNanos),
  };
};
