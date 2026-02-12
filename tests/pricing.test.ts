import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface LiteLLMPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

function cachePathFor(homeDir: string): string {
  return path.join(homeDir, ".config", "cceye", "pricing-cache.json");
}

function writeCache(homeDir: string, updatedAt: number, data: Record<string, LiteLLMPrice>): void {
  const cachePath = cachePathFor(homeDir);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ updatedAt, data }, null, 2));
}

describe("loadPricing", () => {
  let tempHome = "";

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-pricing-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("uses fallback prices in offline mode when cache is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing({ offline: true });
    const sonnet = pricing.getPrice("claude-sonnet-4-5-20250929");

    expect(sonnet).not.toBeNull();
    expect(sonnet?.inputPerMTok).toBe(3);
    expect(sonnet?.cacheCreatePerMTok).toBe(3.75);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers fresh cache and skips network fetch", async () => {
    writeCache(tempHome, Date.now(), {
      "cached-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_creation_input_token_cost: 0.000003,
        cache_read_input_token_cost: 0.000004,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();
    const cached = pricing.getPrice("cached-model");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cached).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheCreatePerMTok: 3,
      cacheReadPerMTok: 4,
    });
  });

  it("fetches pricing data and writes cache when online", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        "claude-sonnet-4-5-20250929": {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          cache_creation_input_token_cost: 0.00000375,
          cache_read_input_token_cost: 0.0000003,
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pricing.getPrice("CLAUDE-SONNET-4-5-20250929")).toMatchObject({
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheCreatePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    });

    const cache = JSON.parse(fs.readFileSync(cachePathFor(tempHome), "utf8")) as {
      updatedAt: number;
      data: Record<string, LiteLLMPrice>;
    };
    expect(cache.updatedAt).toBeGreaterThan(0);
    expect(cache.data["claude-sonnet-4-5-20250929"]).toBeDefined();
  });

  it("falls back to stale cache when network response is not ok", async () => {
    writeCache(tempHome, Date.now() - 3 * 24 * 60 * 60 * 1000, {
      "stale-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        cache_creation_input_token_cost: 0.000003,
        cache_read_input_token_cost: 0.000004,
      },
    });
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();
    const stale = pricing.getPrice("stale-model");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stale).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheCreatePerMTok: 3,
      cacheReadPerMTok: 4,
    });
  });

  it("falls back to stale cache when fetched payload schema is invalid", async () => {
    writeCache(tempHome, Date.now() - 3 * 24 * 60 * 60 * 1000, {
      "stale-model": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ["broken-payload"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pricing.getPrice("stale-model")).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheCreatePerMTok: 0,
      cacheReadPerMTok: 0,
    });
  });

  it("returns empty pricing table when network fails and no cache exists", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pricing.getPrice("non-existent-model")).toBeNull();
  });

  it("supports alternative LiteLLM field names", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        "alt-model": {
          input_cost_per_token: 0.000001,
          cache_creation_input_cost_per_token: 0.000002,
          cache_read_input_cost_per_token: 0.000003,
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing();

    expect(pricing.getPrice("alt-model")).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 0,
      cacheCreatePerMTok: 2,
      cacheReadPerMTok: 3,
    });
  });

  it("handles broken cache JSON and still returns fallback pricing", async () => {
    const cachePath = cachePathFor(tempHome);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "{broken-json}");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing({ offline: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pricing.getPrice("claude-haiku-4-5-20251001")).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 1.25,
      cacheCreatePerMTok: 0.3,
      cacheReadPerMTok: 0.03,
    });
  });

  it("ignores cache with invalid schema and still returns fallback pricing", async () => {
    const cachePath = cachePathFor(tempHome);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: "invalid", data: { broken: true } }, null, 2));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing({ offline: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pricing.getPrice("claude-haiku-4-5-20251001")).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 1.25,
      cacheCreatePerMTok: 0.3,
      cacheReadPerMTok: 0.03,
    });
  });

  it("returns null for unknown models when no fetched/cache/fallback entry exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { loadPricing } = await import("../src/pricing.ts");
    const pricing = await loadPricing({ offline: true });

    expect(pricing.getPrice("non-existent-model")).toBeNull();
  });
});
