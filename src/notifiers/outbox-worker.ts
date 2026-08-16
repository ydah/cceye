import type { NotificationRouter } from "./index.js";
import type { Alert } from "./types.js";
import type { PendingDelivery, UsageStorage } from "../storage/storage.js";

export interface OutboxDrainResult {
  attempted: number;
  delivered: number;
  retrying: number;
  dead: number;
  deliveredDeliveries: PendingDelivery[];
}

export async function drainDeliveryOutbox(
  storage: UsageStorage,
  router: NotificationRouter,
  logger: { error(message: string): void },
  options: { nowMs?: number; limit?: number; maxRetries?: number } = {}
): Promise<OutboxDrainResult> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 50;
  const maxRetries = options.maxRetries ?? 5;
  const deliveries = await storage.claimDeliveries(nowMs, limit);
  const result: OutboxDrainResult = { attempted: 0, delivered: 0, retrying: 0, dead: 0, deliveredDeliveries: [] };

  for (const delivery of deliveries) {
    result.attempted += 1;
    const alertInstance = await storage.getAlert(delivery.alertId);
    if (!alertInstance) {
      const status = await updateFailedDelivery(storage, delivery, "alert instance not found", maxRetries);
      result[status] += 1;
      continue;
    }

    const alert: Alert = {
      level: alertInstance.level,
      window: alertInstance.windowKey as Alert["window"],
      currentCost: Number(alertInstance.currentAmountNanos) / 1_000_000_000,
      threshold: Number(alertInstance.thresholdAmountNanos) / 1_000_000_000,
      timestamp: new Date(alertInstance.lastSeenAtMs),
      transition: delivery.transition,
      idempotencyKey: delivery.idempotencyKey,
    };
    const sent = await router.sendChannel(delivery.channel, alert);
    if (sent.status === "success") {
      await storage.updateDelivery({
        ...delivery,
        status: "delivered",
        attempts: delivery.attempts + 1,
        lastError: null,
        deliveredAtMs: Date.now(),
      });
      result.delivered += 1;
      result.deliveredDeliveries.push({ ...delivery, status: "delivered", attempts: delivery.attempts + 1, leasedAtMs: null });
      continue;
    }

    const error = sent.status === "failed" ? sent.error : sent.reason;
    logger.error(`notification ${delivery.channel} failed: ${error}`);
    const status = await updateFailedDelivery(storage, delivery, error, maxRetries);
    result[status] += 1;
  }
  return result;
}

async function updateFailedDelivery(
  storage: UsageStorage,
  delivery: PendingDelivery,
  error: string,
  maxRetries: number
): Promise<"retrying" | "dead"> {
  const attempts = delivery.attempts + 1;
  const dead = attempts >= maxRetries;
  const base = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempts - 1));
  await storage.updateDelivery({
    ...delivery,
    status: dead ? "dead" : "retrying",
    attempts,
    nextAttemptAtMs: dead ? delivery.nextAttemptAtMs : Date.now() + base + Math.floor(Math.random() * Math.max(1, base * 0.2)),
    lastError: error,
    deliveredAtMs: null,
  });
  return dead ? "dead" : "retrying";
}
