export type MoneyNanos = bigint;

export type CostBasis = "reported" | "estimated" | "hybrid" | "billed";

export interface FileIdentity {
  sourceKind: string;
  canonicalPath: string;
  fileIdentity: string;
}

export interface FileCursor extends FileIdentity {
  generation: number;
  committedOffset: number;
  size: number;
  mtimeMs: number;
  status: "active" | "missing" | "rotated" | "error";
  lastSeenAtMs: number;
}

export interface NormalizedUsageEvent {
  eventId: string;
  source: FileIdentity;
  generation: number;
  occurredAtMs: number;
  project: string | null;
  session: string | null;
  modelRaw: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reportedCostNanos: MoneyNanos | null;
  schemaFingerprint: string | null;
  ingestedAtMs: number;
}

export interface EventCost {
  eventId: string;
  basis: CostBasis;
  amountNanos: MoneyNanos | null;
  currency: string;
  priceSource: string | null;
  priceCatalogHash: string | null;
  matchedModel: string | null;
  matchType: string | null;
  calculatedAtMs: number;
}

export interface UsageQuery {
  fromMs: number;
  untilMs: number;
  basis: CostBasis;
}

export interface IngestionHealth {
  scannedFiles: number;
  changedFiles: number;
  bytesRead: number;
  parsedLines: number;
  usageLines: number;
  malformedLines: number;
  schemaRejectedLines: number;
  duplicateLines: number;
  unpricedEvents: number;
  lastSuccessfulIngestionMs: number | null;
  durationMs: number;
}

export interface UsageBreakdown {
  key: string;
  amountNanos: MoneyNanos | null;
  events: number;
  unpricedEvents: number;
}

export interface CostCoverage {
  pricedEvents: number;
  unpricedEvents: number;
  totalEvents: number;
  pricedInputTokens: number;
  totalInputTokens: number;
  eventCoverageRatio: number;
  tokenCoverageRatio: number;
  complete: boolean;
}

export interface UsageSummary {
  totalAmountNanos: MoneyNanos | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  events: number;
  coverage: CostCoverage;
  byModel: UsageBreakdown[];
  byProject: UsageBreakdown[];
  bySession: UsageBreakdown[];
}

export interface AlertInstance {
  id: string;
  fingerprint: string;
  windowKey: string;
  windowStartMs: number;
  level: "warning" | "critical";
  state: "firing" | "resolved";
  currentAmountNanos: MoneyNanos;
  thresholdAmountNanos: MoneyNanos;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  resolvedAtMs: number | null;
}

export interface PendingDelivery {
  id: string;
  alertId: string;
  channel: string;
  transition: "firing" | "recovery";
  status: "pending" | "leased" | "delivered" | "retrying" | "dead";
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  idempotencyKey: string;
  createdAtMs: number;
  deliveredAtMs: number | null;
}

export interface IntegrityResult {
  ok: boolean;
  message: string;
}

export interface UsageTransaction extends UsageStorage {
  transaction<T>(fn: (tx: UsageTransaction) => T): Promise<T>;
}

export interface UsageStorage {
  migrate(): Promise<void>;
  transaction<T>(fn: (tx: UsageTransaction) => T): Promise<T>;
  getFileCursor(identity: FileIdentity): Promise<FileCursor | null>;
  upsertFileCursor(cursor: FileCursor): Promise<void>;
  insertUsageEvents(events: NormalizedUsageEvent[]): Promise<{ inserted: number; duplicates: number }>;
  insertEventCosts(costs: EventCost[]): Promise<void>;
  ingestBatch(batch: {
    events: NormalizedUsageEvent[];
    costs: EventCost[];
    cursors: FileCursor[];
  }): Promise<{ inserted: number; duplicates: number }>;
  queryUsage(query: UsageQuery): Promise<UsageSummary>;
  createAlert(alert: AlertInstance): Promise<void>;
  enqueueDelivery(delivery: PendingDelivery): Promise<void>;
  listDeliveries(nowMs: number, limit: number): Promise<PendingDelivery[]>;
  updateDelivery(delivery: PendingDelivery): Promise<void>;
  recordIngestionHealth(health: IngestionHealth): Promise<void>;
  getLatestIngestionHealth(): Promise<IngestionHealth | null>;
  checkIntegrity(): Promise<IntegrityResult>;
  close(): Promise<void>;
}
