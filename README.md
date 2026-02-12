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
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.x-3178c6.svg?logo=typescript&logoColor=white">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg">
</p>

---

## Key Features

### Claude Usage Log Parsing

Read Claude Code JSONL session logs from your local `claude_data_dir`, recursively scanning all projects and extracting usage from `message.usage`.

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

Track current costs, hourly trend, model breakdown, and notification history in a keyboard-driven terminal dashboard.

### Smart Pricing Cache

Pricing is fetched from LiteLLM and cached at `~/.config/cceye/pricing-cache.json` (24h TTL), with fallback prices for known models.

### macOS Background Service

Install/uninstall a LaunchAgent for background monitoring with log files under `~/Library/Logs/cceye/`.

---

## Installation

### Prerequisites

- Node.js 20 or later
- Claude Code logs available locally (e.g. `~/.claude/projects`)

### Build from source

```bash
git clone https://github.com/ydah/cceye.git
cd cceye
npm install
npm run build
```

### Run directly

```bash
node dist/index.js status
```

### Development checks

```bash
npm run typecheck
npm run lint
```

---

## Usage

### Quick Start

1. Create config:

```bash
mkdir -p ~/.config/cceye
cp config.example.yaml ~/.config/cceye/config.yaml
```

2. Edit thresholds and notification settings in `~/.config/cceye/config.yaml`.

3. Run a one-shot status check:

```bash
node dist/index.js status
```

4. Start daemon mode:

```bash
node dist/index.js
```

5. Start dashboard mode:

```bash
node dist/index.js dashboard
```

### Commands

```text
cceye [command] [--config /path/to/config.yaml]

Commands:
  (none)     Start daemon mode
  dashboard  Start TUI dashboard mode
  status     Run one poll cycle and print current totals (no notifications)
  init       Interactive config generator
  install    Install macOS LaunchAgent
  uninstall  Remove macOS LaunchAgent
```

Notes:
- Any command accepts `--config <path>`.
- `init` reads `config.example.yaml` from the current working directory.

---

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
| `claude_data_dir` | Root directory containing Claude JSONL logs (`~` expansion supported) |
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
| `dashboard.refresh_interval_seconds` | Required setting (currently not used by runtime logic) |

Legacy:
- `polling_interval_minutes` is still accepted for backward compatibility.
- If both `polling_interval_milliseconds` and `polling_interval_minutes` are set, milliseconds takes precedence.

### Validation rules

- `warning` must be less than `critical` for all windows.
- If Slack is enabled, `webhook_url` is required.
- If email is enabled, these are required:
  - `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `from`, `to`

### Environment variables

| Variable | Description |
|----------|-------------|
| `CCEYE_SLACK_WEBHOOK_URL` | Fills Slack webhook when Slack is enabled and URL is missing in config |
| `CCEYE_SMTP_PASS` | Fills SMTP password when email is enabled and password is missing in config |

---

## Keybindings

### Dashboard Controls

| Key | Action |
|-----|--------|
| `q` / `Ctrl-C` | Quit dashboard |
| `r` | Trigger refresh immediately |
| `d` | Switch model breakdown window to daily |
| `w` | Switch model breakdown window to weekly |
| `m` | Switch model breakdown window to monthly |
| `Tab` | Move focus to next panel |
| `↑` / `↓` | Scroll notification log |

---

## Data Files

| File | Purpose |
|------|---------|
| `~/.config/cceye/config.yaml` | Runtime configuration |
| `~/.config/cceye/state.json` | Notification state, cooldown markers, and internal state |
| `~/.config/cceye/data.json` | Dashboard-facing current aggregates and history |
| `~/.config/cceye/pricing-cache.json` | Cached model pricing data |

---

## macOS LaunchAgent

Install:

```bash
node dist/index.js install --config ~/.config/cceye/config.yaml
```

Uninstall:

```bash
node dist/index.js uninstall --config ~/.config/cceye/config.yaml
```

Logs:

- `~/Library/Logs/cceye/stdout.log`
- `~/Library/Logs/cceye/stderr.log`

---

## Troubleshooting

### `config file not found`

Create `~/.config/cceye/config.yaml` or pass `--config` explicitly.

### `no session logs found`

Verify `claude_data_dir` points to your Claude project logs.

### Slack or Email config errors

When a channel is enabled, all required fields for that channel must be present and valid.

### Dashboard terminal capability errors

Rebuild before running to ensure `dist/` is up to date:

```bash
npm run build
```

---

## Development

```bash
npm run dev
npm test
npm run test:coverage
npm run build
```

---

## Release

The `Release` GitHub Actions workflow publishes when a `v*` tag is pushed.

- Preferred: npm trusted publishing (OIDC). Leave `NPM_TOKEN` unset.
- Fallback: set `NPM_TOKEN` in repository secrets and the workflow will use token auth.
- If token auth fails with `EOTP`, replace `NPM_TOKEN` with an npm Automation token.

---

## License

[MIT License](LICENSE).
