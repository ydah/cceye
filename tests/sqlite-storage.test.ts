import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";

describe("SqliteUsageStorage", () => {
  const storages: SqliteUsageStorage[] = [];

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      await storage.close();
    }
  });

  it("migrates idempotently and reports database integrity", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);

    await storage.migrate();
    await storage.migrate();

    await expect(storage.checkIntegrity()).resolves.toEqual({ ok: true, message: "ok" });
  });

  it("deduplicates events and preserves exact cost amounts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);
    await storage.migrate();

    const source = {
      sourceKind: "claude",
      canonicalPath: "/tmp/project/session.jsonl",
      fileIdentity: "device:1:inode:2",
    } as const;
    const event = {
      eventId: "event-1",
      source,
      generation: 0,
      occurredAtMs: 100,
      project: "project",
      session: "session",
      modelRaw: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 20,
      reportedCostNanos: 123n,
      schemaFingerprint: null,
      ingestedAtMs: 200,
    } as const;

    await expect(storage.insertUsageEvents([event, event])).resolves.toEqual({ inserted: 1, duplicates: 1 });
    await storage.insertEventCosts([
      {
        eventId: "event-1",
        basis: "estimated",
        amountNanos: 456n,
        currency: "USD",
        priceSource: "test",
        priceCatalogHash: "hash",
        matchedModel: event.modelRaw,
        matchType: "exact",
        calculatedAtMs: 300,
      },
    ]);

    const summary = await storage.queryUsage({ fromMs: 0, untilMs: 1000, basis: "estimated" });
    expect(summary.totalAmountNanos).toBe(456n);
    expect(summary.events).toBe(1);
    expect(summary.coverage).toMatchObject({ pricedEvents: 1, unpricedEvents: 0, complete: true });
    expect(summary.byModel).toEqual([
      { key: event.modelRaw, amountNanos: 456n, events: 1, unpricedEvents: 0 },
    ]);
    expect(summary.bySession).toEqual([
      {
        key: "project/session",
        amountNanos: 456n,
        events: 1,
        unpricedEvents: 0,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        pricedInputTokens: 100,
      },
    ]);
    await expect(storage.queryHourlyTrend({ fromMs: 0, untilMs: 1000, basis: "estimated" })).resolves.toEqual([
      { hourStartMs: 0, amountNanos: 456n },
    ]);
    await storage.insertEventCosts([
      {
        eventId: "event-1",
        basis: "estimated",
        amountNanos: 789n,
        currency: "USD",
        priceSource: "new",
        priceCatalogHash: "new-hash",
        matchedModel: event.modelRaw,
        matchType: "exact",
        calculatedAtMs: 400,
      },
    ]);
    await expect(storage.queryUsage({ fromMs: 0, untilMs: 1000, basis: "estimated" })).resolves.toMatchObject({
      totalAmountNanos: 456n,
    });
    await storage.upsertPricingCatalog({
      catalogHash: "hash",
      source: "test",
      fetchedAtMs: 300,
      status: "fresh",
      payloadJson: JSON.stringify({ model: "price" }),
    });
    await expect(storage.getPricingCatalog("hash")).resolves.toMatchObject({ payloadJson: '{"model":"price"}' });
  });

  it("does not turn a partial priced total into a complete-looking amount", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);
    await storage.migrate();
    const source = {
      sourceKind: "claude",
      canonicalPath: "/tmp/project/partial.jsonl",
      fileIdentity: "partial-file",
    } as const;
    await storage.insertUsageEvents([
      {
        eventId: "partial-priced",
        source,
        generation: 0,
        occurredAtMs: 100,
        project: "project",
        session: "session",
        modelRaw: "priced-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reportedCostNanos: null,
        schemaFingerprint: null,
        ingestedAtMs: 1,
      },
      {
        eventId: "partial-unpriced",
        source,
        generation: 0,
        occurredAtMs: 200,
        project: "project",
        session: "session",
        modelRaw: "unknown-model",
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reportedCostNanos: null,
        schemaFingerprint: null,
        ingestedAtMs: 2,
      },
    ]);
    await storage.insertEventCosts([
      {
        eventId: "partial-priced",
        basis: "estimated",
        amountNanos: 100n,
        currency: "USD",
        priceSource: "test",
        priceCatalogHash: null,
        matchedModel: "priced-model",
        matchType: "exact",
        calculatedAtMs: 3,
      },
    ]);

    const summary = await storage.queryUsage({ fromMs: 0, untilMs: 1000, basis: "estimated" });
    expect(summary.totalAmountNanos).toBeNull();
    expect(summary.coverage).toMatchObject({ pricedEvents: 1, unpricedEvents: 1, complete: false });
    expect(summary.byModel).toEqual([
      { key: "priced-model", amountNanos: 100n, events: 1, unpricedEvents: 0 },
      { key: "unknown-model", amountNanos: null, events: 1, unpricedEvents: 1 },
    ]);
    expect(summary.byProject).toEqual([{ key: "project", amountNanos: null, events: 2, unpricedEvents: 1 }]);
  });

  it("stores and loads durable file cursors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);
    await storage.migrate();
    const cursor = {
      sourceKind: "claude",
      canonicalPath: "/tmp/project/session.jsonl",
      fileIdentity: "device:1:inode:2",
      generation: 0,
      committedOffset: 42,
      size: 42,
      mtimeMs: 100,
      status: "active" as const,
      lastSeenAtMs: 200,
    };

    await storage.upsertFileCursor(cursor);

    await expect(storage.getFileCursor(cursor)).resolves.toEqual(cursor);
  });

  it("tracks alert deliveries and ingestion health", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);
    await storage.migrate();
    await storage.transaction((tx) => {
      tx.createAlertSync({
        id: "alert-1",
        fingerprint: "daily:warning:1",
        windowKey: "daily",
        windowStartMs: 0,
        level: "warning",
        state: "firing",
        currentAmountNanos: 100n,
        thresholdAmountNanos: 50n,
        firstSeenAtMs: 1,
        lastSeenAtMs: 2,
        resolvedAtMs: null,
      });
    });
    const delivery = {
      id: "delivery-1",
      alertId: "alert-1",
      channel: "console",
      transition: "firing" as const,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAtMs: 0,
      lastError: null,
      idempotencyKey: "key-1",
      createdAtMs: 1,
      deliveredAtMs: null,
    };
    await storage.enqueueDelivery(delivery);
    const pending = await storage.listDeliveries(1, 10);
    expect(pending).toHaveLength(1);
    await storage.updateDelivery({ ...delivery, status: "delivered", deliveredAtMs: 3, attempts: 1 });
    await expect(storage.listDeliveries(4, 10)).resolves.toHaveLength(0);

    await storage.recordIngestionHealth({
      scannedFiles: 1,
      changedFiles: 1,
      bytesRead: 10,
      parsedLines: 1,
      usageLines: 1,
      malformedLines: 0,
      schemaRejectedLines: 0,
      duplicateLines: 0,
      unpricedEvents: 0,
      lastSuccessfulIngestionMs: 4,
      durationMs: 1,
    });
    await expect(storage.getLatestIngestionHealth()).resolves.toMatchObject({ bytesRead: 10 });
    await expect(storage.queryUsage({ fromMs: 0, untilMs: 1, basis: "estimated" })).resolves.toMatchObject({
      events: 0,
      totalAmountNanos: null,
    });
  });

  it("rolls back synchronous transactional alert writes when a later write fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-ledger-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    storages.push(storage);
    await storage.migrate();

    await expect(
      storage.transaction((tx) => {
        tx.createAlertSync({
          id: "alert-rollback",
          fingerprint: "daily:warning:rollback",
          windowKey: "daily",
          windowStartMs: 0,
          level: "warning",
          state: "firing",
          currentAmountNanos: 1n,
          thresholdAmountNanos: 1n,
          firstSeenAtMs: 1,
          lastSeenAtMs: 1,
          resolvedAtMs: null,
        });
        tx.enqueueDeliverySync({
          id: "delivery-rollback",
          alertId: "missing-alert",
          channel: "test",
          transition: "firing",
          status: "pending",
          attempts: 0,
          nextAttemptAtMs: 0,
          lastError: null,
          idempotencyKey: "rollback",
          createdAtMs: 1,
          deliveredAtMs: null,
        });
      })
    ).rejects.toThrow();

    await expect(storage.getAlert("alert-rollback")).resolves.toBeNull();
  });
});
