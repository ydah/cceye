import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
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

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheCreatePerMTok: number;
  cacheReadPerMTok: number;
  inputPerMTokAbove200k?: number;
  outputPerMTokAbove200k?: number;
  cacheCreatePerMTokAbove200k?: number;
  cacheReadPerMTokAbove200k?: number;
}

export interface ModelPricing {
  getPrice(model: string): ModelPrice | null;
  explain?(model: string): PricingExplanation;
  status?: PricingStatus;
  source?: string;
  cacheUpdatedAt?: number;
  catalogHash?: string | undefined;
  catalogPayload?: Record<string, unknown> | undefined;
}

export type PricingStatus = "fresh" | "stale" | "fallback" | "unavailable";

export interface PricingExplanation {
  rawModel: string;
  matchedModel: string | null;
  matchType: "exact" | "normalized" | "explicit_alias" | "provider_prefix" | "fallback" | "unpriced";
  source: string;
  status: PricingStatus;
  price: ModelPrice | null;
  fetchedAt: number | null;
  catalogHash?: string | undefined;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const providerPrefixes = [
  "anthropic/",
  "claude-3-5-",
  "claude-3-",
  "claude-",
  "openrouter/openai/",
  "openai/",
  "azure/",
] as const;

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
    ...(typeof inputPerMTokAbove200k === "number" ? { inputPerMTokAbove200k } : {}),
    ...(typeof outputPerMTokAbove200k === "number" ? { outputPerMTokAbove200k } : {}),
    ...(typeof cacheCreatePerMTokAbove200k === "number" ? { cacheCreatePerMTokAbove200k } : {}),
    ...(typeof cacheReadPerMTokAbove200k === "number" ? { cacheReadPerMTokAbove200k } : {}),
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

interface MatchedPriceEntry {
  entry: PriceEntry;
  model: string;
  matchType: PricingExplanation["matchType"];
}

function findEntry(
  data: Record<string, PriceEntry>,
  model: string,
  aliases: Record<string, string> = {}
): MatchedPriceEntry | null {
  const normalizedModel = normalizeModel(model);
  const aliasTarget = aliases[normalizedModel];
  const candidates = createModelCandidates(aliasTarget ?? model);
  const normalized = normalizeModel(model);
  for (const [index, candidate] of candidates.entries()) {
    const matched = data[candidate];
    if (matched) {
      const matchType = aliasTarget
        ? "explicit_alias"
        : index === 0
          ? "exact"
          : candidate === normalized
            ? "normalized"
            : "provider_prefix";
      return { entry: matched, model: candidate, matchType };
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

export async function loadPricing(options?: { offline?: boolean; aliases?: Record<string, string> }): Promise<ModelPricing> {
  const cachePath = path.join(os.homedir(), ".config", "cceye", "pricing-cache.json");
  const cached = readCache(cachePath);

  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return buildPricing(cached.data, "fresh", "LiteLLM cache", cached.updatedAt, options?.aliases);
  }

  if (options?.offline) {
    return buildPricing(
      cached?.data ?? {},
      cached ? "stale" : Object.keys(fallbackPrices).length > 0 ? "fallback" : "unavailable",
      cached ? "LiteLLM stale cache" : "built-in fallback",
      cached?.updatedAt ?? null,
      options?.aliases
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref?.();
    try {
      const response = await fetch(PRICING_URL, { signal: controller.signal });
      if (!response.ok) {
        return buildPricing(cached?.data ?? {}, cached ? "stale" : "fallback", "LiteLLM fallback", cached?.updatedAt ?? null, options?.aliases);
      }
      const parsedData = pricingTableSchema.safeParse(await response.json());
      if (!parsedData.success) {
        return buildPricing(cached?.data ?? {}, cached ? "stale" : "fallback", "LiteLLM fallback", cached?.updatedAt ?? null, options?.aliases);
      }
      const data = parsedData.data;
      writeCache(cachePath, data);
      return buildPricing(data, "fresh", "LiteLLM", Date.now(), options?.aliases);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return buildPricing(cached?.data ?? {}, cached ? "stale" : "fallback", "LiteLLM fallback", cached?.updatedAt ?? null, options?.aliases);
  }
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
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(cachePath), 0o700);
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify({ updatedAt: Date.now(), data }, null, 2), { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, cachePath);
  fs.chmodSync(cachePath, 0o600);
}

function buildPricing(
  data: Record<string, PriceEntry>,
  status: PricingStatus,
  source: string,
  cacheUpdatedAt: number | null,
  aliases: Record<string, string> = {}
): ModelPricing {
  const normalizedData = Object.fromEntries(
    Object.entries(data).map(([model, entry]) => [normalizeModel(model), entry])
  );
  const normalizedAliases = Object.fromEntries(
    Object.entries(aliases).map(([model, target]) => [normalizeModel(model), normalizeModel(target)])
  );
  for (const [alias, target] of Object.entries(normalizedAliases)) {
    if (alias.length === 0 || target.length === 0) {
      throw new Error("pricing aliases must have non-empty model names");
    }
    if (!normalizedData[target] && !findFallback(target)) {
      throw new Error(`pricing alias target is not present in the catalog: ${target}`);
    }
  }

  const pricing: ModelPricing = {
    status,
    source,
    catalogHash: hashCatalog(normalizedData),
    catalogPayload: { table: normalizedData, fallback: fallbackPrices },
    getPrice(model: string) {
      const matched = findEntry(normalizedData, model, normalizedAliases);
      if (matched) {
        return toModelPrice(matched.entry);
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
    explain(model: string): PricingExplanation {
      const matched = findEntry(normalizedData, model, normalizedAliases);
      if (matched) {
        return {
          rawModel: model,
          matchedModel: matched.model,
          matchType: matched.matchType,
          source,
          status,
          price: toModelPrice(matched.entry),
          fetchedAt: cacheUpdatedAt,
          catalogHash: pricing.catalogHash,
        };
      }
      const fallback = findFallback(model);
      if (fallback) {
        return {
          rawModel: model,
          matchedModel: normalizeModel(model),
          matchType: "fallback",
          source: "built-in fallback",
          status: status === "fresh" ? "fallback" : status,
          price: {
            inputPerMTok: fallback.input,
            outputPerMTok: fallback.output,
            cacheCreatePerMTok: fallback.cacheCreate,
            cacheReadPerMTok: fallback.cacheRead,
          },
          fetchedAt: cacheUpdatedAt,
          catalogHash: pricing.catalogHash,
        };
      }
      return {
        rawModel: model,
        matchedModel: null,
        matchType: "unpriced",
        source,
        status: "unavailable",
        price: null,
        fetchedAt: cacheUpdatedAt,
        catalogHash: pricing.catalogHash,
      };
    },
  };
  if (cacheUpdatedAt !== null) {
    pricing.cacheUpdatedAt = cacheUpdatedAt;
  }
  return pricing;
}

function hashCatalog(data: Record<string, PriceEntry>): string {
  const canonical = Object.fromEntries(Object.entries(data).sort(([left], [right]) => left.localeCompare(right)));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}
