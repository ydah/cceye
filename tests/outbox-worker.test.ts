import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainDeliveryOutbox } from "../src/notifiers/outbox-worker.ts";
import type { NotificationRouter } from "../src/notifiers/index.ts";
import { SqliteUsageStorage } from "../src/storage/sqlite-storage.ts";

describe("delivery outbox worker", () => {
  const resources: Array<{ directory: string; storage: SqliteUsageStorage }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await resource.storage.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it("delivers a claimed notification with its idempotency key", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-outbox-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    resources.push({ directory, storage });
    await storage.migrate();
    await storage.transaction((tx) => {
      void tx.createAlert({
        id: "alert-success",
        fingerprint: "daily:warning:success",
        windowKey: "daily",
        windowStartMs: 0,
        level: "warning",
        state: "firing",
        currentAmountNanos: 1_000_000_000n,
        thresholdAmountNanos: 500_000_000n,
        firstSeenAtMs: 1,
        lastSeenAtMs: 2,
        resolvedAtMs: null,
      });
      void tx.enqueueDelivery({
        id: "delivery-success",
        alertId: "alert-success",
        channel: "test",
        transition: "firing",
        status: "pending",
        attempts: 0,
        nextAttemptAtMs: 0,
        lastError: null,
        idempotencyKey: "idempotency-success",
        createdAtMs: 1,
        deliveredAtMs: null,
      });
    });

    const sendChannel = vi.fn(async () => ({ channel: "test", status: "success" as const }));
    const result = await drainDeliveryOutbox(storage, { sendChannel } as unknown as NotificationRouter, { error: vi.fn() }, { nowMs: 1 });

    expect(result).toMatchObject({ attempted: 1, delivered: 1, retrying: 0, dead: 0 });
    expect(sendChannel).toHaveBeenCalledWith("test", expect.objectContaining({ idempotencyKey: "idempotency-success" }));
    expect(await storage.getDelivery("delivery-success")).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("retries failures and marks them dead after the configured limit", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-outbox-"));
    const storage = new SqliteUsageStorage(path.join(directory, "cceye.db"));
    resources.push({ directory, storage });
    await storage.migrate();
    await storage.createAlert({
      id: "alert-failure",
      fingerprint: "daily:warning:failure",
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
    await storage.enqueueDelivery({
      id: "delivery-failure",
      alertId: "alert-failure",
      channel: "test",
      transition: "firing",
      status: "pending",
      attempts: 0,
      nextAttemptAtMs: 0,
      lastError: null,
      idempotencyKey: "idempotency-failure",
      createdAtMs: 1,
      deliveredAtMs: null,
    });
    const sendChannel = vi.fn(async () => ({ channel: "test", status: "failed" as const, error: "network failure" }));
    const router = { sendChannel } as unknown as NotificationRouter;
    const logger = { error: vi.fn() };

    const first = await drainDeliveryOutbox(storage, router, logger, { nowMs: 1, maxRetries: 2 });
    expect(first.retrying).toBe(1);
    const second = await drainDeliveryOutbox(storage, router, logger, { nowMs: Date.now() + 3_600_000, maxRetries: 2 });
    expect(second.dead).toBe(1);
    expect(await storage.getDelivery("delivery-failure")).toMatchObject({ status: "dead", attempts: 2, lastError: "network failure" });
  });

  it("dead-letters an orphaned delivery instead of retrying forever", async () => {
    const delivery = {
      id: "delivery-orphan",
      alertId: "missing-alert",
      channel: "test",
      transition: "firing" as const,
      status: "leased" as const,
      attempts: 4,
      nextAttemptAtMs: 0,
      lastError: null,
      idempotencyKey: "idempotency-orphan",
      createdAtMs: 1,
      deliveredAtMs: null,
    };
    let updated = delivery;
    const storage = {
      claimDeliveries: vi.fn(async () => [delivery]),
      getAlert: vi.fn(async () => null),
      updateDelivery: vi.fn(async (next: typeof delivery) => {
        updated = next;
      }),
    } as never;

    const result = await drainDeliveryOutbox(storage, { sendChannel: vi.fn() } as unknown as NotificationRouter, { error: vi.fn() }, { nowMs: 1, maxRetries: 5 });
    expect(result.dead).toBe(1);
    expect(updated).toMatchObject({ status: "dead", attempts: 5 });
  });
});
