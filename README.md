<p align="center">
  <img src="assets/logo-header.svg" alt="cceye header logo">
</p>

<p align="center">
  <b>Monitor Claude Code usage costs from local logs with threshold alerts.</b>
</p>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#keybindings">Keybindings</a>
</p>

<p align="center">
  <a href="https://badge.fury.io/js/cceye"><img src="https://badge.fury.io/js/cceye.svg" alt="npm version" height="18"></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.x-3178c6.svg?logo=typescript&logoColor=white">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg">
</p>

## Key Features

### Claude Usage Log Parsing

Read Claude Code JSONL session logs from your local data directories, recursively scanning all projects and extracting usage from `message.usage`.

Data roots are discovered in this order:
- `CLAUDE_CONFIG_DIR` (comma-separated directories, highest priority)
- `claude_data_dir` from config
- auto-discovered defaults (`~/.config/claude/projects`, `~/.claude/projects`)

Note: When `CLAUDE_CONFIG_DIR` is set, it overrides all other roots and must resolve to at least one existing `projects/` directory. If none of the configured directories contain `projects/`, cceye errors instead of falling back to `claude_data_dir` or auto-discovered defaults.

### Cost Tracking Modes

Choose how costs are computed:
- `auto`: use `costUSD` from log when present, otherwise calculate from token pricing
- `calculate`: always calculate from token counts
- `display`: always use `costUSD` from log (fallback to `0`)

### Threshold Alerts

Evaluate spend against `daily`, `weekly`, and `monthly` thresholds with `warning` and `critical` levels.

### Multi-Channel Notifications

Send alerts to:
- Console output
- macOS Notification Center
- Slack webhook
- SMTP email

### Live Dashboard (TUI)

Track current costs, hourly trend, model/project breakdown, and notification history in a keyboard-driven terminal dashboard.

### Usage Reports

Generate report snapshots with:
- `daily`
- `weekly`
- `monthly`
- `session`

Each report supports date filters and JSON output options.

### Smart Pricing Cache

Pricing is fetched from LiteLLM and cached at `~/.config/cceye/pricing-cache.json` (24h TTL), with fallback prices for known models. Network failures are reported as stale/fallback pricing and do not stop local monitoring. Use `cceye prices explain MODEL` to inspect the exact model match and price source; unknown models remain unpriced instead of becoming zero-dollar usage.

### macOS Background Service

Install/uninstall a LaunchAgent for background monitoring with log files under `~/Library/Logs/cceye/`.

## Installation

### Prerequisites

- Node.js 20 or later
- Claude Code logs available locally (e.g. `~/.claude/projects`)

### Install from npm (recommended)

```bash
npm install -g cceye
```

### Run without install

```bash
npx cceye status
```

### Build from source (development)

```bash
git clone https://github.com/ydah/cceye.git
cd cceye
npm install
npm run build
```

### Development checks

```bash
npm run typecheck
npm run lint
```

## Usage

### Quick Start

If you installed globally, use `cceye`. If not, replace it with `npx cceye`.

1. Generate config interactively:

```bash
cceye init
```

2. Edit thresholds and notification settings in `~/.config/cceye/config.yaml`.

3. Run a one-shot status check:

```bash
cceye status
```

4. Start daemon mode (foreground, silent):

```bash
cceye
```

5. Start daemon mode with logs (debug):

```bash
cceye -d
```

6. Start dashboard mode:

```bash
cceye dashboard
```

### Commands

```text
cceye [command] [--config /path/to/config.yaml]

Commands:
  --version  Print CLI version
  -v         Print CLI version
  (none)     Start daemon mode (silent)
  debug      Start daemon mode with logs
  --debug    Enable debug logs for daemon mode
  -d         Alias for --debug
  dashboard  Start TUI dashboard mode
  status     Run one poll cycle and print current totals (no notifications)
  daily      Print daily usage report
  weekly     Print weekly usage report
  monthly    Print monthly usage report
  session    Print session usage report
  prices     Explain model pricing provenance
  billing    Sync or inspect optional Anthropic billing data
  reconcile  Compare local usage with provider billing
  doctor     Check local data quality and database health
  notifications reset  Clear notification cooldown state
  alerts retry ID  Retry a failed notification delivery
  notify test [--channel NAME]  Send a test notification without changing thresholds
  db check|backup|rebuild  Check, back up, or rebuild the SQLite ledger
  init       Interactive config generator
  install    Install macOS LaunchAgent
  uninstall  Remove macOS LaunchAgent
```

#### Notes
- Any command accepts `--config <path>`.
- Report commands support:
  - `--since YYYYMMDD`
  - `--until YYYYMMDD`
  - `--json`
  - `--breakdown`
  - `--timezone <IANA TZ>`
  - `--offline`
  - `--show-coverage`
  - `--top N` and `--other` for breakdown output
- If not installed globally, run commands with `npx cceye <command>`.
- Notification cooldown state survives daemon restarts. Use an explicit state-management command when a manual reset is needed.
- Delivery is at-least-once: a crash after a remote send and before local acknowledgement can produce a duplicate. Each outbox row has a local idempotency key.

## Configuration

### Config file location

Default path:

```text
~/.config/cceye/config.yaml
```

See `config.example.yaml` for a complete template.

### Key fields

| Field | Description |
|------|-------------|
| `claude_data_dir` | Fallback root directory containing Claude JSONL logs (`~` expansion supported) |
| `polling_interval_milliseconds` | Polling interval in milliseconds (`>= 1`) |
| `timezone` | Timezone used for daily/weekly/monthly window boundaries |
| `cost_mode` | `auto`, `calculate`, or `display` |
| `thresholds.*` | Warning/Critical cost thresholds per window |
| `notifications.console.enabled` | Enable console alerts |
| `notifications.macos.enabled` | Enable macOS notifications |
| `notifications.macos.sound` | Play notification sound on macOS |
| `notifications.slack.enabled` | Enable Slack alerts |
| `notifications.slack.webhook_url` | Slack Incoming Webhook URL |
| `notifications.slack.mention` | Optional mention prefix (`<!channel>`, `<@U...>`) |
| `notifications.email.enabled` | Enable SMTP email alerts |
| `notifications.email.*` | SMTP sender/recipient/auth settings |
| `notification_cooldown_minutes` | Cooldown for repeated alerts of same window/level |
| `log_level` | `debug`, `info`, `warn`, `error` |
| `dashboard.refresh_interval_seconds` | Dashboard redraw interval; independent from usage polling |
| `alerts.notify_on_recovery` | Send a notification when a threshold returns below warning |
| `alerts.max_retries` | Maximum attempts before a delivery becomes dead |
| `storage.database_path` | Absolute path to the SQLite usage ledger |
| `pricing.aliases` | Explicit raw-model to catalog-model mappings |
| `billing.anthropic.enabled` | Enable manual Cost Report sync (disabled by default) |

### Validation rules

- `warning` must be less than `critical` for all windows.
- If Slack is enabled, `webhook_url` is required.
- If email is enabled, these are required:
  - `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `from`, `to`

### Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Comma-separated Claude config roots; each must contain `projects/` |
| `CCEYE_SLACK_WEBHOOK_URL` | Fills Slack webhook when Slack is enabled and URL is missing in config |
| `CCEYE_SMTP_PASS` | Fills SMTP password when email is enabled and password is missing in config |

## Keybindings

### Dashboard Controls

| Key | Action |
|-----|--------|
| `q` / `Ctrl-C` | Quit dashboard |
| `r` | Trigger refresh immediately |
| `d` | Switch breakdown window to daily (current target) |
| `w` | Switch breakdown window to weekly (current target) |
| `m` | Switch breakdown window to monthly (current target) |
| `p` | Toggle breakdown target (model / project) |
| `Tab` | Move focus to next panel |
| `↑` / `↓` | Scroll notification log |

## Data Files

| File | Purpose |
|------|---------|
| `~/.config/cceye/config.yaml` | Runtime configuration |
| `~/.config/cceye/state.json` | Notification state, cooldown markers, and internal state |
| `~/.config/cceye/data.json` | Dashboard-facing current aggregates, coverage, and history |
| `~/.config/cceye/pricing-cache.json` | Cached model pricing data |
| `~/.config/cceye/cceye.db` | Transactional usage ledger, cursors, costs, alerts, and billing records |

Database maintenance commands create private backups and never delete the legacy JSON files:

```bash
cceye db check
cceye db backup
cceye db rebuild
```

If migration fails, the database is preserved with a `.failed-TIMESTAMP` suffix for inspection.

## Run as a Background Daemon

### Option 1: macOS LaunchAgent (recommended)

This is the most reliable way to keep the daemon running in the background on macOS, including after login.

#### Install

```bash
cceye install --config ~/.config/cceye/config.yaml
```

#### Uninstall

```bash
cceye uninstall --config ~/.config/cceye/config.yaml
```

#### Logs

- `~/Library/Logs/cceye/stdout.log`
- `~/Library/Logs/cceye/stderr.log`

### Option 2: `nohup` (quick/manual)

Use this when you want a simple background process without installing LaunchAgent.

#### Start

```bash
mkdir -p ~/.local/state/cceye
nohup cceye --config ~/.config/cceye/config.yaml > ~/.local/state/cceye/daemon.log 2>&1 &
echo $! > ~/.local/state/cceye/daemon.pid
```

#### Stop

```bash
kill "$(cat ~/.local/state/cceye/daemon.pid)"
rm -f ~/.local/state/cceye/daemon.pid
```

## Troubleshooting

### Privacy model

cceye stores usage metadata and cost provenance locally. It does not store prompt or response bodies. Billing sync is disabled by default and sends only the configured date range to Anthropic's Cost Report API. API keys are read from the configured environment variable and are never written to the config file.

### `config file not found`

Create `~/.config/cceye/config.yaml` or pass `--config` explicitly.

### `no session logs found`

Verify the following, depending on your environment:
- If `CLAUDE_CONFIG_DIR` is set: ensure its paths exist and contain Claude session logs, or unset it.
- Otherwise, ensure either:
  - `claude_data_dir` points to Claude session logs, or
  - one default path exists and contains logs:
    - `~/.config/claude/projects`
    - `~/.claude/projects`

### Slack or Email config errors

When a channel is enabled, all required fields for that channel must be present and valid.

### Dashboard terminal capability errors

When running from source, rebuild before running to ensure `dist/` is up to date:

```bash
npm run build
```

## Development

```bash
npm run dev
npm test
npm run test:coverage
npm run build
```

## Migration Notes

- Existing config files remain valid.
- Path resolution is now more flexible:
  - If `CLAUDE_CONFIG_DIR` is set, those paths are used exclusively.
  - Otherwise, `claude_data_dir` is used, with auto-discovered defaults appended when available.
- New report commands are available:
  - `cceye daily`
  - `cceye weekly`
  - `cceye monthly`
  - `cceye session`

## License

[MIT License](LICENSE).
