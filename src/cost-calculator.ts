import type { UsageEntry } from "./log-parser.js";
import type { ModelPricing } from "./pricing.js";

export type CostMode = "auto" | "calculate" | "display";

export function calculateCost(entry: UsageEntry, mode: CostMode, pricing: ModelPricing): number {
  if (mode === "display") {
    return entry.costUSD ?? 0;
  }
  if (mode === "auto" && entry.costUSD !== null) {
    return entry.costUSD;
  }

  const price = pricing.getPrice(entry.model);
  if (!price) {
    return 0;
  }

  const inputCost = (entry.inputTokens * price.inputPerMTok) / 1_000_000;
  const outputCost = (entry.outputTokens * price.outputPerMTok) / 1_000_000;
  const cacheCreateCost = (entry.cacheCreationTokens * price.cacheCreatePerMTok) / 1_000_000;
  const cacheReadCost = (entry.cacheReadTokens * price.cacheReadPerMTok) / 1_000_000;

  return inputCost + outputCost + cacheCreateCost + cacheReadCost;
}
