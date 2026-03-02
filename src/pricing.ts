import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";

const priceEntrySchema = z
  .object({
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    input_cost_per_token_above_200k_tokens: z.number().optional(),
    output_cost_per_token_above_200k_tokens: z.number().optional(),
    cache_creation_input_cost_per_token: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    cache_creation_input_cost_per_token_above_200k_tokens: z.number().optional(),
    cache_creation_input_token_cost_above_200k_tokens: z.number().optional(),
    cache_read_input_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    cache_read_input_cost_per_token_above_200k_tokens: z.number().optional(),
    cache_read_input_token_cost_above_200k_tokens: z.number().optional(),
  })
  .passthrough();

const pricingTableSchema = z.record(z.string(), priceEntrySchema);

const pricingCacheSchema = z.object({
  updatedAt: z.number().int().nonnegative(),
  data: pricingTableSchema,
});

type PriceEntry = z.infer<typeof priceEntrySchema>;

const modelPriceSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheCreatePerMTok: z.number(),
  cacheReadPerMTok: z.number(),
  inputPerMTokAbove200k: z.number().optional(),
  outputPerMTokAbove200k: z.number().optional(),
  cacheCreatePerMTokAbove200k: z.number().optional(),
  cacheReadPerMTokAbove200k: z.number().optional(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export interface ModelPricing {
  getPrice(model: string): ModelPrice | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const providerPrefixes = ["anthropic/", "openrouter/openai/", "openai/", "azure/"] as const;

const fallbackPrices: Record<string, { input: number; output: number; cacheCreate: number; cacheRead: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0, cacheCreate: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25, cacheCreate: 0.3, cacheRead: 0.03 },
  "claude-opus-4-5-20250901": { input: 15.0, output: 75.0, cacheCreate: 18.75, cacheRead: 1.5 },
  "claude-opus-4-5-20251101": { input: 5.0, output: 25.0, cacheCreate: 6.25, cacheRead: 0.5 },
};

function toPerMTok(value?: number): number {
  return (value ?? 0) * 1_000_000;
}

function toPerMTokOptional(value?: number): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  return value * 1_000_000;
}

function toModelPrice(entry: PriceEntry): ModelPrice {
  const inputPerMTokAbove200k = toPerMTokOptional(entry.input_cost_per_token_above_200k_tokens);
  const outputPerMTokAbove200k = toPerMTokOptional(entry.output_cost_per_token_above_200k_tokens);
  const cacheCreatePerMTokAbove200k = toPerMTokOptional(
    entry.cache_creation_input_token_cost_above_200k_tokens ??
      entry.cache_creation_input_cost_per_token_above_200k_tokens
  );
  const cacheReadPerMTokAbove200k = toPerMTokOptional(
    entry.cache_read_input_token_cost_above_200k_tokens ?? entry.cache_read_input_cost_per_token_above_200k_tokens
  );
  return {
    inputPerMTok: toPerMTok(entry.input_cost_per_token),
    outputPerMTok: toPerMTok(entry.output_cost_per_token),
    cacheCreatePerMTok: toPerMTok(entry.cache_creation_input_token_cost ?? entry.cache_creation_input_cost_per_token),
    cacheReadPerMTok: toPerMTok(entry.cache_read_input_token_cost ?? entry.cache_read_input_cost_per_token),
    ...(inputPerMTokAbove200k !== undefined ? { inputPerMTokAbove200k } : {}),
    ...(outputPerMTokAbove200k !== undefined ? { outputPerMTokAbove200k } : {}),
    ...(cacheCreatePerMTokAbove200k !== undefined ? { cacheCreatePerMTokAbove200k } : {}),
    ...(cacheReadPerMTokAbove200k !== undefined ? { cacheReadPerMTokAbove200k } : {}),
  };
}

function stripProviderPrefix(model: string): string {
  for (const prefix of providerPrefixes) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

function createModelCandidates(model: string): string[] {
  const normalized = normalizeModel(model);
  const stripped = stripProviderPrefix(normalized);
  const candidates = new Set<string>([normalized, stripped]);

  for (const prefix of providerPrefixes) {
    candidates.add(`${prefix}${normalized}`);
    candidates.add(`${prefix}${stripped}`);
  }

  return Array.from(candidates).filter((candidate) => candidate.length > 0);
}

function findEntry(data: Record<string, PriceEntry>, model: string): PriceEntry | null {
  const candidates = createModelCandidates(model);
  for (const candidate of candidates) {
    const matched = data[candidate];
    if (matched) {
      return matched;
    }
  }

  const normalized = normalizeModel(model);
  for (const [key, value] of Object.entries(data)) {
    if (key.includes(normalized)) {
      return value;
    }
  }

  return null;
}

function findFallback(model: string): { input: number; output: number; cacheCreate: number; cacheRead: number } | null {
  const candidates = createModelCandidates(model);
  for (const candidate of candidates) {
    const matched = fallbackPrices[candidate];
    if (matched) {
      return matched;
    }
  }
  return null;
}

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
  const normalizedData = Object.fromEntries(
    Object.entries(data).map(([model, entry]) => [normalizeModel(model), entry])
  );

  return {
    getPrice(model: string) {
      const entry = findEntry(normalizedData, model);
      if (entry) {
        return toModelPrice(entry);
      }
      const fallback = findFallback(model);
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
