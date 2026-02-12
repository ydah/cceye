import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";

const priceEntrySchema = z
  .object({
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_creation_input_cost_per_token: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    cache_read_input_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
  })
  .passthrough();

const pricingTableSchema = z.record(z.string(), priceEntrySchema);

const pricingCacheSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  data: pricingTableSchema,
});

type PriceEntry = z.infer<typeof priceEntrySchema>;

export interface ModelPricing {
  getPrice(model: string): {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheCreatePerMTok: number;
    cacheReadPerMTok: number;
  } | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const fallbackPrices: Record<string, { input: number; output: number; cacheCreate: number; cacheRead: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25, cacheCreate: 0.3, cacheRead: 0.03 },
  "claude-opus-4-5-20250901": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5-20251101": { input: 5.0, output: 25.0, cacheCreate: 6.25, cacheRead: 0.5 },
};

export async function loadPricing(options?: { offline?: boolean }): Promise<ModelPricing> {
  const cachePath = path.join(os.homedir(), ".config", "cceye", "pricing-cache.json");
  const cached = readCache(cachePath);

  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return buildPricing(cached.data);
  }

  if (options?.offline) {
    return buildPricing(cached?.data ?? {});
  }

  const response = await fetch(PRICING_URL);
  if (!response.ok) {
    return buildPricing(cached?.data ?? {});
  }
  const parsedData = pricingTableSchema.safeParse(await response.json());
  if (!parsedData.success) {
    return buildPricing(cached?.data ?? {});
  }
  const data = parsedData.data;
  writeCache(cachePath, data);
  return buildPricing(data);
}

function readCache(cachePath: string): { updatedAt: number; data: Record<string, PriceEntry> } | null {
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = pricingCacheSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, data: Record<string, PriceEntry>): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), data }, null, 2));
}

function buildPricing(data: Record<string, PriceEntry>): ModelPricing {
  return {
    getPrice(model: string) {
      const normalized = normalizeModel(model);
      const entry = data[normalized] ?? data[model];
      if (entry) {
        return {
          inputPerMTok: (entry.input_cost_per_token ?? 0) * 1_000_000,
          outputPerMTok: (entry.output_cost_per_token ?? 0) * 1_000_000,
          cacheCreatePerMTok:
            (entry.cache_creation_input_token_cost ?? entry.cache_creation_input_cost_per_token ?? 0) *
            1_000_000,
          cacheReadPerMTok: (entry.cache_read_input_token_cost ?? entry.cache_read_input_cost_per_token ?? 0) * 1_000_000,
        };
      }
      const fallback = fallbackPrices[normalized] ?? fallbackPrices[model];
      if (!fallback) {
        return null;
      }
      return {
        inputPerMTok: fallback.input,
        outputPerMTok: fallback.output,
        cacheCreatePerMTok: fallback.cacheCreate,
        cacheReadPerMTok: fallback.cacheRead,
      };
    },
  };
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}
