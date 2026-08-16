import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAnthropicBilling } from "../src/billing/billing-sync.ts";
import { reconcileUsage } from "../src/billing/reconciliation.ts";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";

describe("billing", () => {
  const resources: Array<{ directory: string; storage: SqliteUsageStorage }> = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.CCEYE_TEST_ADMIN_KEY;
    for (const resource of resources.splice(0)) {
      await resource.storage.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it("syncs idempotent records from the Cost Report API", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-billing-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    resources.push({ directory, storage });
    await storage.migrate();
    const empty = await reconcileUsage(storage, 0, 1000);
    expect(empty.localEstimatedNanos).toBeNull();
    expect(empty.differenceNanos).toBeNull();
    await expect(
      syncAnthropicBilling({ enabled: false, api_key_env: "CCEYE_TEST_ADMIN_KEY" }, storage, new Date(0), new Date(1))
    ).rejects.toThrow("billing is disabled");
    await expect(
      syncAnthropicBilling({ enabled: true, api_key_env: "CCEYE_TEST_ADMIN_KEY" }, storage, new Date(0), new Date(1))
    ).rejects.toThrow("authentication failed");
    process.env.CCEYE_TEST_ADMIN_KEY = "secret";
    let amount = "1.25";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: [
          {
            starting_at: "2026-08-01T00:00:00.000Z",
            ending_at: "2026-08-02T00:00:00.000Z",
            results: [{ amount, currency: "USD", description: "api" }],
          },
        ],
        has_more: false,
      }),
    })));

    const config = { enabled: true, api_key_env: "CCEYE_TEST_ADMIN_KEY" };
    const first = await syncAnthropicBilling(config, storage, new Date("2026-08-01"), new Date("2026-08-02"));
    const second = await syncAnthropicBilling(config, storage, new Date("2026-08-01"), new Date("2026-08-02"));
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    await expect(storage.queryBilling(0, Date.now() + 1)).resolves.toHaveLength(1);

    amount = "2.50";
    await syncAnthropicBilling(config, storage, new Date("2026-08-01"), new Date("2026-08-02"));
    await expect(storage.queryBilling(0, Date.now() + 1)).resolves.toMatchObject([
      expect.objectContaining({ amountNanos: 2_500_000_000n, revision: 2, isCurrent: true }),
    ]);
  });

  it("keeps reconciliation dimensions honest", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-billing-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    resources.push({ directory, storage });
    await storage.migrate();
    const source = { sourceKind: "claude", canonicalPath: "/tmp/session.jsonl", fileIdentity: "identity" } as const;
    await storage.insertUsageEvents([
      {
        eventId: "event-1",
        source,
        generation: 0,
        occurredAtMs: 100,
        project: "project",
        session: "session",
        modelRaw: "model",
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reportedCostNanos: null,
        schemaFingerprint: null,
        ingestedAtMs: 1,
      },
    ]);
    await storage.insertEventCosts([
      {
        eventId: "event-1",
        basis: "estimated",
        amountNanos: 150n,
        currency: "USD",
        priceSource: "test",
        priceCatalogHash: null,
        matchedModel: "model",
        matchType: "exact",
        calculatedAtMs: 1,
      },
    ]);
    await storage.upsertBillingRecord({
      recordId: "record-1",
      provider: "anthropic",
      periodStartMs: 0,
      periodEndMs: 1000,
      amountNanos: 100n,
      currency: "USD",
      dimensions: { description: "api" },
      fetchedAtMs: 1,
    });

    const result = await reconcileUsage(storage, 0, 1000);
    expect(result.providerBilledNanos).toBe(100n);
    expect(result.localEstimatedNanos).toBe(150n);
    expect(result.differenceNanos).toBe(50n);
    expect(result.differenceRatio).toBe(0.5);
  });
});
