# Usage Baseline Fixtures

This fixture set is used as a deterministic regression baseline for parser and aggregation behavior.

## Dataset

- Path root: `tests/fixtures/usage-baseline/mixed-logs/mixed-schema`
- Includes:
  - mixed `costUSD` available/missing entries
  - cache token present/missing entries
  - duplicated `message.id + requestId` across files
  - large token entry (`input_tokens = 300000`) for pricing edge-case coverage

## Expected Baseline (Daily, UTC, frozen at 2026-02-15T15:00:00.000Z)

- Deduplicated entries: `6`
- Token totals:
  - `input: 300370`
  - `output: 100185`
  - `cacheCreation: 200020`
  - `cacheRead: 50010`
- Cost totals by mode:
  - `auto: 4.3571`
  - `calculate: 3.168228`
  - `display: 1.19`

Notes:
- `auto` uses `costUSD` when present, otherwise token-based calculation.
- `calculate` always uses token-based calculation.
- `display` uses only `costUSD`; missing values remain unpriced (`null`/`UNPRICED`).
