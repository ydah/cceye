import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { ledgerSchema } from "./sqlite-schema.js";
import type {
  AlertInstance,
  EventCost,
  FileCursor,
  FileIdentity,
  IntegrityResult,
  IngestionHealth,
  NormalizedUsageEvent,
  PendingDelivery,
  UsageBreakdown,
  UsageQuery,
  UsageStorage,
  UsageSummary,
  UsageTransaction,
} from "./storage.js";

const schemaVersion = 1;

export class SqliteUsageStorage implements UsageStorage {
  private readonly database: Database.Database;

  constructor(databasePath = defaultDatabasePath()) {
    if (!path.isAbsolute(databasePath)) {
      throw new Error("database path must be absolute");
    }
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new Database(databasePath);
    this.database.defaultSafeIntegers(true);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    fs.chmodSync(databasePath, 0o600);
  }

  async migrate(): Promise<void> {
    const migrate = this.database.transaction(() => {
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)"
      );
      const applied = this.database
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(schemaVersion);
      if (applied) {
        return;
      }
      this.database.exec(ledgerSchema);
      this.database
        .prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)")
        .run(schemaVersion, Date.now());
    });
    migrate();
  }

  async transaction<T>(fn: (tx: UsageTransaction) => T): Promise<T> {
    const run = this.database.transaction(() => fn(this));
    return run();
  }

  async getFileCursor(identity: FileIdentity): Promise<FileCursor | null> {
    const row = this.database
      .prepare(
        `SELECT source_kind, canonical_path, file_identity, generation, committed_offset,
                size, mtime_ms, status, last_seen_at_ms
           FROM source_files
          WHERE source_kind = ? AND canonical_path = ? AND file_identity = ?
          ORDER BY generation DESC LIMIT 1`
      )
      .get(identity.sourceKind, identity.canonicalPath, identity.fileIdentity) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return mapFileCursor(row);
  }

  async upsertFileCursor(cursor: FileCursor): Promise<void> {
    this.upsertFileCursorSync(cursor);
  }

  private upsertFileCursorSync(cursor: FileCursor): void {
    this.database
      .prepare(
        `INSERT INTO source_files
          (source_kind, canonical_path, file_identity, generation, committed_offset, size, mtime_ms, status, last_seen_at_ms)
         VALUES (@sourceKind, @canonicalPath, @fileIdentity, @generation, @committedOffset, @size, @mtimeMs, @status, @lastSeenAtMs)
         ON CONFLICT(source_kind, file_identity, generation) DO UPDATE SET
           canonical_path = excluded.canonical_path,
           committed_offset = excluded.committed_offset,
           size = excluded.size,
           mtime_ms = excluded.mtime_ms,
           status = excluded.status,
           last_seen_at_ms = excluded.last_seen_at_ms`
      )
      .run({
        sourceKind: cursor.sourceKind,
        canonicalPath: cursor.canonicalPath,
        fileIdentity: cursor.fileIdentity,
        generation: cursor.generation,
        committedOffset: cursor.committedOffset,
        size: cursor.size,
        mtimeMs: cursor.mtimeMs,
        status: cursor.status,
        lastSeenAtMs: cursor.lastSeenAtMs,
      });
  }

  async insertUsageEvents(events: NormalizedUsageEvent[]): Promise<{ inserted: number; duplicates: number }> {
    const insert = this.database.transaction(() => this.insertUsageEventsSync(events));
    return insert();
  }

  async insertEventCosts(costs: EventCost[]): Promise<void> {
    const insert = this.database.transaction(() => {
      this.insertEventCostsSync(costs);
    });
    insert();
  }

  async ingestBatch(batch: {
    events: NormalizedUsageEvent[];
    costs: EventCost[];
    cursors: FileCursor[];
  }): Promise<{ inserted: number; duplicates: number }> {
    const ingest = this.database.transaction(() => {
      const result = this.insertUsageEventsSync(batch.events);
      this.insertEventCostsSync(batch.costs);
      for (const cursor of batch.cursors) {
        this.upsertFileCursorSync(cursor);
      }
      return result;
    });
    return ingest();
  }

  async queryUsage(query: UsageQuery): Promise<UsageSummary> {
    const costExpression = this.costExpression(query.basis);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS events,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_tokens) AS cache_creation_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(${costExpression}) AS total_amount_nanos,
                SUM(CASE WHEN ${costExpression} IS NOT NULL THEN 1 ELSE 0 END) AS priced_events,
                SUM(CASE WHEN ${costExpression} IS NOT NULL THEN input_tokens ELSE 0 END) AS priced_input_tokens
           FROM usage_events e
           LEFT JOIN event_costs c ON c.event_id = e.event_id AND c.basis = ?
          WHERE occurred_at_ms >= ? AND occurred_at_ms < ?`
      )
      .get(query.basis, query.fromMs, query.untilMs) as Record<string, unknown>;
    const totalEvents = toNumber(row.events);
    const pricedEvents = toNumber(row.priced_events);
    const inputTokens = toNumber(row.input_tokens);
    const pricedInputTokens = toNumber(row.priced_input_tokens);
    const summaryBase = {
      totalAmountNanos: toNullableBigInt(row.total_amount_nanos),
      inputTokens,
      outputTokens: toNumber(row.output_tokens),
      cacheCreationTokens: toNumber(row.cache_creation_tokens),
      cacheReadTokens: toNumber(row.cache_read_tokens),
      events: totalEvents,
      coverage: makeCoverage(totalEvents, pricedEvents, inputTokens, pricedInputTokens),
    };
    const [byModel, byProject, bySession] = await Promise.all([
      this.queryBreakdown("model_raw", query),
      this.queryBreakdown("project", query),
      this.queryBreakdown("session", query),
    ]);
    return { ...summaryBase, byModel, byProject, bySession };
  }

  async createAlert(alert: AlertInstance): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO alert_instances
          (id, fingerprint, window_key, window_start_ms, level, state, current_amount_nanos,
           threshold_amount_nanos, first_seen_at_ms, last_seen_at_ms, resolved_at_ms)
         VALUES (@id, @fingerprint, @windowKey, @windowStartMs, @level, @state, @currentAmountNanos,
                 @thresholdAmountNanos, @firstSeenAtMs, @lastSeenAtMs, @resolvedAtMs)
         ON CONFLICT(fingerprint) DO UPDATE SET
           current_amount_nanos = excluded.current_amount_nanos,
           state = excluded.state,
           last_seen_at_ms = excluded.last_seen_at_ms,
           resolved_at_ms = excluded.resolved_at_ms`
      )
      .run({ ...alert });
  }

  async enqueueDelivery(delivery: PendingDelivery): Promise<void> {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO delivery_outbox
          (id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
           idempotency_key, created_at_ms, delivered_at_ms)
         VALUES (@id, @alertId, @channel, @transition, @status, @attempts, @nextAttemptAtMs,
                 @lastError, @idempotencyKey, @createdAtMs, @deliveredAtMs)`
      )
      .run({ ...delivery });
  }

  async listDeliveries(nowMs: number, limit: number): Promise<PendingDelivery[]> {
    const rows = this.database
      .prepare(
        `SELECT id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
                idempotency_key, created_at_ms, delivered_at_ms
           FROM delivery_outbox
          WHERE status IN ('pending', 'retrying') AND next_attempt_at_ms <= ?
          ORDER BY next_attempt_at_ms ASC LIMIT ?`
      )
      .all(nowMs, limit) as Record<string, unknown>[];
    return rows.map(mapDelivery);
  }

  async updateDelivery(delivery: PendingDelivery): Promise<void> {
    this.database
      .prepare(
        `UPDATE delivery_outbox SET status = @status, attempts = @attempts,
          next_attempt_at_ms = @nextAttemptAtMs, last_error = @lastError, delivered_at_ms = @deliveredAtMs
         WHERE id = @id`
      )
      .run({ ...delivery });
  }

  async recordIngestionHealth(health: IngestionHealth): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO ingestion_metrics
          (scanned_files, changed_files, bytes_read, parsed_lines, usage_lines, malformed_lines,
           schema_rejected_lines, duplicate_lines, unpriced_events, last_successful_ingestion_ms,
           duration_ms, created_at_ms)
         VALUES (@scannedFiles, @changedFiles, @bytesRead, @parsedLines, @usageLines, @malformedLines,
                 @schemaRejectedLines, @duplicateLines, @unpricedEvents, @lastSuccessfulIngestionMs,
                 @durationMs, @createdAtMs)`
      )
      .run({
        ...health,
        createdAtMs: Date.now(),
      });
  }

  async getLatestIngestionHealth(): Promise<IngestionHealth | null> {
    const row = this.database
      .prepare(
        `SELECT scanned_files, changed_files, bytes_read, parsed_lines, usage_lines, malformed_lines,
                schema_rejected_lines, duplicate_lines, unpriced_events, last_successful_ingestion_ms, duration_ms
           FROM ingestion_metrics ORDER BY id DESC LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      scannedFiles: toNumber(row.scanned_files),
      changedFiles: toNumber(row.changed_files),
      bytesRead: toNumber(row.bytes_read),
      parsedLines: toNumber(row.parsed_lines),
      usageLines: toNumber(row.usage_lines),
      malformedLines: toNumber(row.malformed_lines),
      schemaRejectedLines: toNumber(row.schema_rejected_lines),
      duplicateLines: toNumber(row.duplicate_lines),
      unpricedEvents: toNumber(row.unpriced_events),
      lastSuccessfulIngestionMs:
        row.last_successful_ingestion_ms === null ? null : toNumber(row.last_successful_ingestion_ms),
      durationMs: toNumber(row.duration_ms),
    };
  }

  async checkIntegrity(): Promise<IntegrityResult> {
    const row = this.database.pragma("integrity_check", { simple: true });
    const message = String(row);
    return { ok: message === "ok", message };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private insertUsageEventsSync(events: NormalizedUsageEvent[]): { inserted: number; duplicates: number } {
    let inserted = 0;
    let duplicates = 0;
    const sourceFile = this.database.prepare(
      `INSERT INTO source_files
        (source_kind, canonical_path, file_identity, generation, committed_offset, size, mtime_ms, status, last_seen_at_ms)
       VALUES (?, ?, ?, ?, 0, 0, 0, 'active', ?)
       ON CONFLICT(source_kind, file_identity, generation) DO UPDATE SET canonical_path = excluded.canonical_path
       RETURNING id`
    );
    const event = this.database.prepare(
      `INSERT OR IGNORE INTO usage_events
        (event_id, source_kind, source_file_id, occurred_at_ms, project, session, model_raw,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reported_cost_nanos,
         schema_fingerprint, ingested_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const value of events) {
      const sourceFileRow = sourceFile.get(
        value.source.sourceKind,
        value.source.canonicalPath,
        value.source.fileIdentity,
        value.generation,
        value.ingestedAtMs
      ) as { id: bigint };
      const result = event.run(
        value.eventId,
        value.source.sourceKind,
        sourceFileRow.id,
        value.occurredAtMs,
        value.project,
        value.session,
        value.modelRaw,
        value.inputTokens,
        value.outputTokens,
        value.cacheCreationTokens,
        value.cacheReadTokens,
        value.reportedCostNanos,
        value.schemaFingerprint,
        value.ingestedAtMs
      );
      if (Number(result.changes) === 1) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }
    return { inserted, duplicates };
  }

  private insertEventCostsSync(costs: EventCost[]): void {
    const statement = this.database.prepare(
      `INSERT INTO event_costs
        (event_id, basis, amount_nanos, currency, price_source, price_catalog_hash, matched_model, match_type, calculated_at_ms)
       VALUES (@eventId, @basis, @amountNanos, @currency, @priceSource, @priceCatalogHash, @matchedModel, @matchType, @calculatedAtMs)
       ON CONFLICT(event_id, basis) DO UPDATE SET
         amount_nanos = excluded.amount_nanos,
         currency = excluded.currency,
         price_source = excluded.price_source,
         price_catalog_hash = excluded.price_catalog_hash,
         matched_model = excluded.matched_model,
         match_type = excluded.match_type,
         calculated_at_ms = excluded.calculated_at_ms`
    );
    for (const cost of costs) {
      statement.run({
        eventId: cost.eventId,
        basis: cost.basis,
        amountNanos: cost.amountNanos,
        currency: cost.currency,
        priceSource: cost.priceSource,
        priceCatalogHash: cost.priceCatalogHash,
        matchedModel: cost.matchedModel,
        matchType: cost.matchType,
        calculatedAtMs: cost.calculatedAtMs,
      });
    }
  }

  private costExpression(basis: UsageQuery["basis"]): string {
    if (basis === "reported") {
      return "e.reported_cost_nanos";
    }
    if (basis === "hybrid") {
      return "COALESCE(c.amount_nanos, e.reported_cost_nanos)";
    }
    return "c.amount_nanos";
  }

  private async queryBreakdown(column: "model_raw" | "project" | "session", query: UsageQuery): Promise<UsageBreakdown[]> {
    const costExpression = this.costExpression(query.basis);
    const rows = this.database
      .prepare(
        `SELECT COALESCE(${column}, 'unknown') AS key,
                SUM(${costExpression}) AS amount_nanos,
                COUNT(*) AS events,
                SUM(CASE WHEN ${costExpression} IS NULL THEN 1 ELSE 0 END) AS unpriced_events
           FROM usage_events e
           LEFT JOIN event_costs c ON c.event_id = e.event_id AND c.basis = ?
          WHERE occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY ${column}
          ORDER BY amount_nanos DESC`
      )
      .all(query.basis, query.fromMs, query.untilMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: String(row.key),
      amountNanos: toNullableBigInt(row.amount_nanos),
      events: toNumber(row.events),
      unpricedEvents: toNumber(row.unpriced_events),
    }));
  }
}

export const defaultDatabasePath = (): string => path.join(os.homedir(), ".config", "cceye", "cceye.db");

const toNumber = (value: unknown): number => {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const toNullableBigInt = (value: unknown): bigint | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
};

const mapFileCursor = (row: Record<string, unknown>): FileCursor => ({
  sourceKind: String(row.source_kind),
  canonicalPath: String(row.canonical_path),
  fileIdentity: String(row.file_identity),
  generation: toNumber(row.generation),
  committedOffset: toNumber(row.committed_offset),
  size: toNumber(row.size),
  mtimeMs: toNumber(row.mtime_ms),
  status: String(row.status) as FileCursor["status"],
  lastSeenAtMs: toNumber(row.last_seen_at_ms),
});

const mapDelivery = (row: Record<string, unknown>): PendingDelivery => ({
  id: String(row.id),
  alertId: String(row.alert_id),
  channel: String(row.channel),
  transition: String(row.transition) as PendingDelivery["transition"],
  status: String(row.status) as PendingDelivery["status"],
  attempts: toNumber(row.attempts),
  nextAttemptAtMs: toNumber(row.next_attempt_at_ms),
  lastError: row.last_error === null ? null : String(row.last_error),
  idempotencyKey: String(row.idempotency_key),
  createdAtMs: toNumber(row.created_at_ms),
  deliveredAtMs: row.delivered_at_ms === null ? null : toNumber(row.delivered_at_ms),
});

const makeCoverage = (
  totalEvents: number,
  pricedEvents: number,
  totalInputTokens: number,
  pricedInputTokens: number
) => ({
  pricedEvents,
  unpricedEvents: totalEvents - pricedEvents,
  totalEvents,
  pricedInputTokens,
  totalInputTokens,
  eventCoverageRatio: totalEvents === 0 ? 1 : pricedEvents / totalEvents,
  tokenCoverageRatio: totalInputTokens === 0 ? 1 : pricedInputTokens / totalInputTokens,
  complete: pricedEvents === totalEvents,
});
