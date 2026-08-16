import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { ledgerSchema } from "./sqlite-schema.js";
import type {
  AlertInstance,
  BillingRecord,
  DeliveryCounts,
  EventCost,
  FileCursor,
  FileIdentity,
  IntegrityResult,
  IngestionHealth,
  NormalizedUsageEvent,
  ParserError,
  PendingDelivery,
  PricingCatalog,
  UsageBreakdown,
  UsageQuery,
  UsageStorage,
  UsageSummary,
  UsageTrendPoint,
  UsageTransaction,
} from "./storage.js";

const schemaVersion = 3;
const deliveryLeaseDurationMs = 5 * 60 * 1000;

export class SqliteUsageStorage implements UsageStorage {
  private readonly database: Database.Database;
  private readonly databasePath: string;

  constructor(databasePath = defaultDatabasePath()) {
    if (!path.isAbsolute(databasePath)) {
      throw new Error("database path must be absolute");
    }
    const directory = path.dirname(databasePath);
    this.databasePath = databasePath;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    let database: Database.Database | null = null;
    try {
      database = new Database(databasePath);
      database.defaultSafeIntegers(true);
      database.pragma("journal_mode = WAL");
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      fs.chmodSync(databasePath, 0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${databasePath}${suffix}`;
        if (fs.existsSync(sidecar)) {
          fs.chmodSync(sidecar, 0o600);
        }
      }
    } catch (error) {
      if (database?.open) {
        database.close();
      }
      const failedPath = preserveFailedDatabase(databasePath);
      throw new Error(`database could not be opened; preserved failed database at ${failedPath}: ${String(error)}`);
    }
    if (!database) {
      throw new Error("database could not be opened");
    }
    this.database = database;
  }

  async migrate(): Promise<void> {
    const migrate = this.database.transaction(() => {
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)"
      );
      const latest = this.database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as Record<string, unknown>;
      const latestVersion = latest.version === null ? 0 : toNumber(latest.version);
      if (latestVersion > schemaVersion) {
        throw new Error(`unsupported database schema version: ${latestVersion}`);
      }
      this.database.exec(ledgerSchema);
      if (latestVersion < 2) {
        addColumnIfMissing(this.database, "delivery_outbox", "leased_at_ms", "INTEGER");
        this.insertSchemaVersion(2);
      }
      if (latestVersion < 3) {
        addColumnIfMissing(this.database, "billing_records", "revision_key", "TEXT");
        addColumnIfMissing(this.database, "billing_records", "revision", "INTEGER NOT NULL DEFAULT 1");
        addColumnIfMissing(this.database, "billing_records", "is_current", "INTEGER NOT NULL DEFAULT 1");
        this.database.exec(
          "UPDATE billing_records SET revision_key = provider || char(0) || period_start_ms || char(0) || period_end_ms || char(0) || currency || char(0) || dimensions_json WHERE revision_key IS NULL"
        );
        this.insertSchemaVersion(3);
      }
      this.database.exec("CREATE INDEX IF NOT EXISTS billing_records_revision_idx ON billing_records(revision_key, is_current)");
    });
    try {
      migrate();
    } catch (error) {
      if (this.database.open) {
        this.database.close();
      }
      const failedPath = preserveFailedDatabase(this.databasePath);
      throw new Error(`database migration failed; preserved failed database at ${failedPath}: ${String(error)}`);
    }
  }

  private insertSchemaVersion(version: number): void {
    this.database
      .prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)")
      .run(version, Date.now());
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

  async listFileCursors(): Promise<FileCursor[]> {
    const rows = this.database
      .prepare(
        `SELECT source_kind, canonical_path, file_identity, generation, committed_offset,
                size, mtime_ms, status, last_seen_at_ms
           FROM source_files ORDER BY generation DESC`
      )
      .all() as Record<string, unknown>[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const cursor = mapFileCursor(row);
      const key = `${cursor.sourceKind}\0${cursor.fileIdentity}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [cursor];
    });
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
    parserErrors?: ParserError[];
    pricingCatalog?: PricingCatalog | undefined;
  }): Promise<{ inserted: number; duplicates: number }> {
    const ingest = this.database.transaction(() => {
      const result = this.insertUsageEventsSync(batch.events);
      this.insertEventCostsSync(batch.costs);
      for (const cursor of batch.cursors) {
        this.upsertFileCursorSync(cursor);
      }
      this.insertParserErrorsSync(batch.parserErrors ?? []);
      if (batch.pricingCatalog) {
        this.upsertPricingCatalogSync(batch.pricingCatalog);
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
                CASE WHEN SUM(CASE WHEN ${costExpression} IS NULL THEN 1 ELSE 0 END) > 0
                     THEN NULL ELSE SUM(${costExpression}) END AS total_amount_nanos,
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
      this.queryBreakdown("session", query, true),
    ]);
    return { ...summaryBase, byModel, byProject, bySession };
  }

  async queryHourlyTrend(query: UsageQuery): Promise<UsageTrendPoint[]> {
    const costExpression = this.costExpression(query.basis);
    const rows = this.database
      .prepare(
        `SELECT CAST(occurred_at_ms / 3600000 AS INTEGER) * 3600000 AS hour_ms,
                CASE WHEN SUM(CASE WHEN ${costExpression} IS NULL THEN 1 ELSE 0 END) > 0
                     THEN NULL ELSE SUM(${costExpression}) END AS amount_nanos
           FROM usage_events e
           LEFT JOIN event_costs c ON c.event_id = e.event_id AND c.basis = ?
          WHERE occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY hour_ms
          ORDER BY hour_ms ASC`
      )
      .all(query.basis, query.fromMs, query.untilMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      hourStartMs: toNumber(row.hour_ms),
      amountNanos: toNullableBigInt(row.amount_nanos),
    }));
  }

  async createAlert(alert: AlertInstance): Promise<void> {
    this.createAlertSync(alert);
  }

  createAlertSync(alert: AlertInstance): void {
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

  async getAlert(id: string): Promise<AlertInstance | null> {
    const row = this.database
      .prepare(
        `SELECT id, fingerprint, window_key, window_start_ms, level, state, current_amount_nanos,
                threshold_amount_nanos, first_seen_at_ms, last_seen_at_ms, resolved_at_ms
           FROM alert_instances WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapAlert(row) : null;
  }

  async hasDeliveredDelivery(alertId: string, transition: PendingDelivery["transition"]): Promise<boolean> {
    const row = this.database
      .prepare(
        `SELECT 1
           FROM delivery_outbox
          WHERE alert_id = ? AND transition = ? AND status = 'delivered'
          LIMIT 1`
      )
      .get(alertId, transition);
    return row !== undefined;
  }

  async enqueueDelivery(delivery: PendingDelivery): Promise<void> {
    this.enqueueDeliverySync(delivery);
  }

  enqueueDeliverySync(delivery: PendingDelivery): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO delivery_outbox
          (id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
           idempotency_key, created_at_ms, delivered_at_ms, leased_at_ms)
         VALUES (@id, @alertId, @channel, @transition, @status, @attempts, @nextAttemptAtMs,
                 @lastError, @idempotencyKey, @createdAtMs, @deliveredAtMs, @leasedAtMs)`
      )
      .run({ ...delivery, leasedAtMs: delivery.leasedAtMs ?? null });
  }

  async claimDeliveries(nowMs: number, limit: number): Promise<PendingDelivery[]> {
    const claim = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE delivery_outbox
              SET status = 'retrying', next_attempt_at_ms = ?, leased_at_ms = NULL
            WHERE status = 'leased' AND leased_at_ms IS NOT NULL AND leased_at_ms <= ?`
        )
        .run(nowMs, nowMs - deliveryLeaseDurationMs);
      const rows = this.database
        .prepare(
          `SELECT id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
                  idempotency_key, created_at_ms, delivered_at_ms, leased_at_ms
             FROM delivery_outbox
            WHERE status IN ('pending', 'retrying') AND next_attempt_at_ms <= ?
            ORDER BY next_attempt_at_ms ASC LIMIT ?`
        )
        .all(nowMs, limit) as Record<string, unknown>[];
      const update = this.database.prepare(
        "UPDATE delivery_outbox SET status = 'leased', leased_at_ms = ? WHERE id = ? AND status IN ('pending', 'retrying')"
      );
      const claimed: PendingDelivery[] = [];
      for (const row of rows) {
        const result = update.run(nowMs, String(row.id));
        if (Number(result.changes) === 1) {
          claimed.push(mapDelivery({ ...row, status: "leased", leased_at_ms: nowMs }));
        }
      }
      return claimed;
    });
    return claim();
  }

  async listDeliveries(nowMs: number, limit: number): Promise<PendingDelivery[]> {
    const rows = this.database
      .prepare(
        `SELECT id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
                idempotency_key, created_at_ms, delivered_at_ms, leased_at_ms
           FROM delivery_outbox
          WHERE status IN ('pending', 'retrying') AND next_attempt_at_ms <= ?
          ORDER BY next_attempt_at_ms ASC LIMIT ?`
      )
      .all(nowMs, limit) as Record<string, unknown>[];
    return rows.map(mapDelivery);
  }

  async getDelivery(id: string): Promise<PendingDelivery | null> {
    const row = this.database
      .prepare(
        `SELECT id, alert_id, channel, transition, status, attempts, next_attempt_at_ms, last_error,
                idempotency_key, created_at_ms, delivered_at_ms, leased_at_ms
           FROM delivery_outbox WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapDelivery(row) : null;
  }

  async retryDelivery(id: string): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE delivery_outbox
            SET status = 'retrying', next_attempt_at_ms = ?, last_error = NULL, delivered_at_ms = NULL, leased_at_ms = NULL
          WHERE id = ? AND status IN ('dead', 'retrying', 'pending', 'leased')`
      )
      .run(Date.now(), id);
    return Number(result.changes) === 1;
  }

  async getDeliveryCounts(): Promise<DeliveryCounts> {
    const rows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM delivery_outbox GROUP BY status")
      .all() as Record<string, unknown>[];
    const counts: DeliveryCounts = { pending: 0, retrying: 0, leased: 0, delivered: 0, dead: 0 };
    for (const row of rows) {
      const status = String(row.status) as keyof DeliveryCounts;
      if (status in counts) {
        counts[status] = toNumber(row.count);
      }
    }
    return counts;
  }

  async updateDelivery(delivery: PendingDelivery): Promise<void> {
    this.database
      .prepare(
        `UPDATE delivery_outbox SET status = @status, attempts = @attempts,
          next_attempt_at_ms = @nextAttemptAtMs, last_error = @lastError, delivered_at_ms = @deliveredAtMs,
          leased_at_ms = @leasedAtMs
         WHERE id = @id`
      )
      .run({ ...delivery, leasedAtMs: delivery.status === "leased" ? delivery.leasedAtMs ?? Date.now() : null });
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

  async listParserErrors(limit: number): Promise<ParserError[]> {
    const rows = this.database
      .prepare(
        `SELECT p.offset, p.error_digest, p.reason, s.source_kind, s.canonical_path,
                s.file_identity, s.generation
           FROM parser_errors p
           LEFT JOIN source_files s ON s.id = p.source_file_id
          ORDER BY p.id DESC LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      source: {
        sourceKind: String(row.source_kind ?? "unknown"),
        canonicalPath: String(row.canonical_path ?? "unknown"),
        fileIdentity: String(row.file_identity ?? "unknown"),
      },
      generation: toNumber(row.generation),
      offset: toNumber(row.offset),
      errorDigest: String(row.error_digest),
      reason: String(row.reason),
    }));
  }

  async upsertPricingCatalog(catalog: PricingCatalog): Promise<void> {
    this.upsertPricingCatalogSync(catalog);
  }

  async getPricingCatalog(catalogHash: string): Promise<PricingCatalog | null> {
    const row = this.database
      .prepare("SELECT catalog_hash, source, fetched_at_ms, status, payload_json FROM pricing_catalogs WHERE catalog_hash = ?")
      .get(catalogHash) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      catalogHash: String(row.catalog_hash),
      source: String(row.source),
      fetchedAtMs: toNumber(row.fetched_at_ms),
      status: String(row.status),
      payloadJson: String(row.payload_json),
    };
  }

  async upsertBillingRecord(record: BillingRecord): Promise<void> {
    const revisionKey = record.revisionKey ?? createBillingRevisionKey(record);
    const current = this.database
      .prepare(
        `SELECT record_id, revision, amount_nanos
           FROM billing_records
          WHERE revision_key = ? AND is_current = 1
          ORDER BY revision DESC LIMIT 1`
      )
      .get(revisionKey) as Record<string, unknown> | undefined;
    if (current && toNullableBigInt(current.amount_nanos) === record.amountNanos) {
      this.database
        .prepare("UPDATE billing_records SET fetched_at_ms = ? WHERE record_id = ?")
        .run(record.fetchedAtMs, String(current.record_id));
      return;
    }
    const revision = current ? toNumber(current.revision) + 1 : 1;
    if (current) {
      this.database
        .prepare("UPDATE billing_records SET is_current = 0 WHERE record_id = ?")
        .run(String(current.record_id));
    }
    this.database
      .prepare(
        `INSERT INTO billing_records
          (record_id, provider, period_start_ms, period_end_ms, amount_nanos, currency, dimensions_json,
           fetched_at_ms, revision_key, revision, is_current)
         VALUES (@recordId, @provider, @periodStartMs, @periodEndMs, @amountNanos, @currency, @dimensionsJson,
                 @fetchedAtMs, @revisionKey, @revision, 1)
         ON CONFLICT(record_id) DO UPDATE SET
           amount_nanos = excluded.amount_nanos,
           currency = excluded.currency,
           dimensions_json = excluded.dimensions_json,
           fetched_at_ms = excluded.fetched_at_ms,
           revision_key = excluded.revision_key,
           revision = excluded.revision,
           is_current = excluded.is_current`
      )
      .run({
        recordId: record.recordId,
        provider: record.provider,
        periodStartMs: record.periodStartMs,
        periodEndMs: record.periodEndMs,
        amountNanos: record.amountNanos,
        currency: record.currency,
        dimensionsJson: JSON.stringify(record.dimensions),
        fetchedAtMs: record.fetchedAtMs,
        revisionKey,
        revision,
      });
  }

  async queryBilling(fromMs: number, untilMs: number): Promise<BillingRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT record_id, provider, period_start_ms, period_end_ms, amount_nanos, currency, dimensions_json,
                fetched_at_ms, revision_key, revision, is_current
           FROM billing_records
          WHERE period_start_ms < ? AND period_end_ms > ? AND is_current = 1
          ORDER BY period_start_ms ASC`
      )
      .all(untilMs, fromMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      recordId: String(row.record_id),
      provider: String(row.provider),
      periodStartMs: toNumber(row.period_start_ms),
      periodEndMs: toNumber(row.period_end_ms),
      amountNanos: toNullableBigInt(row.amount_nanos) ?? 0n,
      currency: String(row.currency),
      dimensions: parseDimensions(row.dimensions_json),
      fetchedAtMs: toNumber(row.fetched_at_ms),
      revisionKey: String(row.revision_key ?? row.record_id),
      revision: toNumber(row.revision),
      isCurrent: toNumber(row.is_current) === 1,
    }));
  }

  async resolveAlert(input: {
    fingerprint: string;
    currentAmountNanos: bigint;
    resolvedAtMs: number;
  }): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE alert_instances
            SET state = 'resolved', current_amount_nanos = ?, last_seen_at_ms = ?, resolved_at_ms = ?
          WHERE fingerprint = ? AND state = 'firing'`
      )
      .run(input.currentAmountNanos, input.resolvedAtMs, input.resolvedAtMs, input.fingerprint);
    return Number(result.changes) === 1;
  }

  async hasPendingRecovery(fingerprint: string): Promise<boolean> {
    const row = this.database
      .prepare(
        `SELECT 1
           FROM delivery_outbox d
           JOIN alert_instances a ON a.id = d.alert_id
          WHERE a.fingerprint = ? AND d.transition = 'recovery'
            AND d.status IN ('pending', 'retrying', 'leased')
          LIMIT 1`
      )
      .get(fingerprint);
    return row !== undefined;
  }

  async checkIntegrity(): Promise<IntegrityResult> {
    const row = this.database.pragma("integrity_check", { simple: true });
    const message = String(row);
    return { ok: message === "ok", message };
  }

  async close(): Promise<void> {
    if (this.database.open) {
      this.database.close();
    }
  }

  private insertUsageEventsSync(events: NormalizedUsageEvent[]): { inserted: number; duplicates: number } {
    let inserted = 0;
    let duplicates = 0;
    const event = this.database.prepare(
      `INSERT OR IGNORE INTO usage_events
        (event_id, source_kind, source_file_id, occurred_at_ms, project, session, model_raw,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reported_cost_nanos,
         schema_fingerprint, ingested_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const value of events) {
      const sourceFileId = this.sourceFileIdSync(value.source, value.generation, value.ingestedAtMs);
      const result = event.run(
        value.eventId,
        value.source.sourceKind,
        sourceFileId,
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
      `INSERT OR IGNORE INTO event_costs
        (event_id, basis, amount_nanos, currency, price_source, price_catalog_hash, matched_model, match_type, calculated_at_ms)
       VALUES (@eventId, @basis, @amountNanos, @currency, @priceSource, @priceCatalogHash, @matchedModel, @matchType, @calculatedAtMs)`
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

  private insertParserErrorsSync(errors: ParserError[]): void {
    const statement = this.database.prepare(
      `INSERT INTO parser_errors (source_file_id, offset, error_digest, reason, created_at_ms)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const error of errors) {
      const sourceFileId = this.sourceFileIdSync(error.source, error.generation, Date.now());
      statement.run(sourceFileId, error.offset, error.errorDigest, error.reason, Date.now());
    }
  }

  private upsertPricingCatalogSync(catalog: PricingCatalog): void {
    this.database
      .prepare(
        `INSERT INTO pricing_catalogs (catalog_hash, source, fetched_at_ms, status, payload_json)
         VALUES (@catalogHash, @source, @fetchedAtMs, @status, @payloadJson)
         ON CONFLICT(catalog_hash) DO UPDATE SET
           source = excluded.source,
           fetched_at_ms = excluded.fetched_at_ms,
           status = excluded.status,
           payload_json = excluded.payload_json`
      )
      .run({ ...catalog });
  }

  private sourceFileIdSync(source: FileIdentity, generation: number, lastSeenAtMs: number): bigint {
    const row = this.database
      .prepare(
        `INSERT INTO source_files
          (source_kind, canonical_path, file_identity, generation, committed_offset, size, mtime_ms, status, last_seen_at_ms)
         VALUES (?, ?, ?, ?, 0, 0, 0, 'active', ?)
         ON CONFLICT(source_kind, file_identity, generation) DO UPDATE SET canonical_path = excluded.canonical_path
         RETURNING id`
      )
      .get(source.sourceKind, source.canonicalPath, source.fileIdentity, generation, lastSeenAtMs) as { id: bigint };
    return row.id;
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

  private async queryBreakdown(
    column: "model_raw" | "project" | "session",
    query: UsageQuery,
    includeTokenMetrics = false
  ): Promise<UsageBreakdown[]> {
    const costExpression = this.costExpression(query.basis);
    const keyExpression =
      column === "session" ? "COALESCE(project, 'unknown') || '/' || COALESCE(session, 'unknown')" : `COALESCE(${column}, 'unknown')`;
    const rows = this.database
      .prepare(
        `SELECT ${keyExpression} AS key,
                CASE WHEN SUM(CASE WHEN ${costExpression} IS NULL THEN 1 ELSE 0 END) > 0
                     THEN NULL ELSE SUM(${costExpression}) END AS amount_nanos,
                COUNT(*) AS events,
                SUM(CASE WHEN ${costExpression} IS NULL THEN 1 ELSE 0 END) AS unpriced_events
                ${includeTokenMetrics ? `,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_creation_tokens) AS cache_creation_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(CASE WHEN ${costExpression} IS NOT NULL THEN input_tokens ELSE 0 END) AS priced_input_tokens` : ""}
           FROM usage_events e
           LEFT JOIN event_costs c ON c.event_id = e.event_id AND c.basis = ?
          WHERE occurred_at_ms >= ? AND occurred_at_ms < ?
          GROUP BY ${keyExpression}
          ORDER BY amount_nanos DESC`
      )
      .all(query.basis, query.fromMs, query.untilMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: String(row.key),
      amountNanos: toNullableBigInt(row.amount_nanos),
      events: toNumber(row.events),
      unpricedEvents: toNumber(row.unpriced_events),
      ...(includeTokenMetrics
        ? {
            inputTokens: toNumber(row.input_tokens),
            outputTokens: toNumber(row.output_tokens),
            cacheCreationTokens: toNumber(row.cache_creation_tokens),
            cacheReadTokens: toNumber(row.cache_read_tokens),
            pricedInputTokens: toNumber(row.priced_input_tokens),
          }
        : {}),
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

const addColumnIfMissing = (database: Database.Database, table: string, column: string, definition: string): void => {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (columns.some((candidate) => String(candidate.name) === column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const preserveFailedDatabase = (databasePath: string): string => {
  const failedPath = `${databasePath}.failed-${Date.now()}`;
  if (fs.existsSync(databasePath)) {
    fs.renameSync(databasePath, failedPath);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.renameSync(sidecar, `${failedPath}${suffix}`);
    }
  }
  return failedPath;
};

const createBillingRevisionKey = (record: BillingRecord): string =>
  `${record.provider}\0${record.periodStartMs}\0${record.periodEndMs}\0${record.currency}\0${JSON.stringify(record.dimensions)}`;

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
  leasedAtMs: row.leased_at_ms === null || row.leased_at_ms === undefined ? null : toNumber(row.leased_at_ms),
});

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

const mapAlert = (row: Record<string, unknown>): AlertInstance => ({
  id: String(row.id),
  fingerprint: String(row.fingerprint),
  windowKey: String(row.window_key),
  windowStartMs: toNumber(row.window_start_ms),
  level: String(row.level) as AlertInstance["level"],
  state: String(row.state) as AlertInstance["state"],
  currentAmountNanos: toNullableBigInt(row.current_amount_nanos) ?? 0n,
  thresholdAmountNanos: toNullableBigInt(row.threshold_amount_nanos) ?? 0n,
  firstSeenAtMs: toNumber(row.first_seen_at_ms),
  lastSeenAtMs: toNumber(row.last_seen_at_ms),
  resolvedAtMs: row.resolved_at_ms === null ? null : toNumber(row.resolved_at_ms),
});

const parseDimensions = (value: unknown): Record<string, string> => {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
};

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
