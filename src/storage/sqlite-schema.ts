export const ledgerSchema = `
CREATE TABLE IF NOT EXISTS source_files (
  id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  committed_offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(source_kind, file_identity, generation)
);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_file_id INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  project TEXT,
  session TEXT,
  model_raw TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  reported_cost_nanos INTEGER,
  schema_fingerprint TEXT,
  ingested_at_ms INTEGER NOT NULL,
  FOREIGN KEY(source_file_id) REFERENCES source_files(id)
);

CREATE TABLE IF NOT EXISTS event_costs (
  event_id TEXT NOT NULL,
  basis TEXT NOT NULL,
  amount_nanos INTEGER,
  currency TEXT NOT NULL,
  price_source TEXT,
  price_catalog_hash TEXT,
  matched_model TEXT,
  match_type TEXT,
  calculated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(event_id, basis),
  FOREIGN KEY(event_id) REFERENCES usage_events(event_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pricing_catalogs (
  catalog_hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_instances (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  window_key TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  level TEXT NOT NULL,
  state TEXT NOT NULL,
  current_amount_nanos INTEGER NOT NULL,
  threshold_amount_nanos INTEGER NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS delivery_outbox (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  transition TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  delivered_at_ms INTEGER,
  leased_at_ms INTEGER,
  FOREIGN KEY(alert_id) REFERENCES alert_instances(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_records (
  record_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  amount_nanos INTEGER NOT NULL,
  currency TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  revision_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS parser_errors (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER,
  offset INTEGER NOT NULL,
  error_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY(source_file_id) REFERENCES source_files(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ingestion_metrics (
  id INTEGER PRIMARY KEY,
  scanned_files INTEGER NOT NULL,
  changed_files INTEGER NOT NULL,
  bytes_read INTEGER NOT NULL,
  parsed_lines INTEGER NOT NULL,
  usage_lines INTEGER NOT NULL,
  malformed_lines INTEGER NOT NULL,
  schema_rejected_lines INTEGER NOT NULL,
  duplicate_lines INTEGER NOT NULL,
  unpriced_events INTEGER NOT NULL,
  last_successful_ingestion_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx ON usage_events(occurred_at_ms);
CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(model_raw);
CREATE INDEX IF NOT EXISTS delivery_outbox_due_idx ON delivery_outbox(status, next_attempt_at_ms);
`;
