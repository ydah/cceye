import type { UsageEntry } from "./log-parser.js";
import type { ModelPricing } from "./pricing.js";

export type CostMode = "auto" | "calculate" | "display";

function calculateTieredCost(tokens: number, basePerMTok: number, abovePerMTok?: number): number {
  if (tokens <= 0) {
    return 0;
  }

  const threshold = 200_000;
  if (abovePerMTok === undefined || tokens <= threshold) {
    return (tokens * basePerMTok) / 1_000_000;
  }

  const belowThresholdTokens = threshold;
  const aboveThresholdTokens = tokens - threshold;
  return (belowThresholdTokens * basePerMTok + aboveThresholdTokens * abovePerMTok) / 1_000_000;
}

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

  const inputCost = calculateTieredCost(entry.inputTokens, price.inputPerMTok, price.inputPerMTokAbove200k);
  const outputCost = calculateTieredCost(entry.outputTokens, price.outputPerMTok, price.outputPerMTokAbove200k);
  const cacheCreateCost = calculateTieredCost(
    entry.cacheCreationTokens,
    price.cacheCreatePerMTok,
    price.cacheCreatePerMTokAbove200k
  );
  const cacheReadCost = calculateTieredCost(entry.cacheReadTokens, price.cacheReadPerMTok, price.cacheReadPerMTokAbove200k);

  return inputCost + outputCost + cacheCreateCost + cacheReadCost;
}
