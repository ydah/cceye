import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function baseConfigYaml(overrides = ""): string {
  return `claude_data_dir: "~/claude"
polling_interval_milliseconds: 300000
timezone: "UTC"
cost_mode: "auto"
thresholds:
  daily:
    warning: 5
    critical: 10
  weekly:
    warning: 25
    critical: 50
  monthly:
    warning: 80
    critical: 150
notifications:
  console:
    enabled: true
  macos:
    enabled: false
    sound: false
  slack:
    enabled: false
    mention: ""
  email:
    enabled: false
    smtp_secure: false
notification_cooldown_minutes: 60
log_level: "info"
dashboard:
  refresh_interval_seconds: 60
${overrides}`;
}

describe("config", () => {
  let tempDir = "";
  let tempHome = "";

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-config-"));
    tempHome = path.join(tempDir, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    delete process.env.CCEYE_SLACK_WEBHOOK_URL;
    delete process.env.CCEYE_SMTP_PASS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.CCEYE_SLACK_WEBHOOK_URL;
    delete process.env.CCEYE_SMTP_PASS;
  });

  it("resolves default config path under home directory", async () => {
    const { resolveConfigPath } = await import("../src/config.ts");
    expect(resolveConfigPath()).toBe(path.join(tempHome, ".config", "cceye", "config.yaml"));
  });

  it("loads valid config and expands home directory", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(configPath, baseConfigYaml());
    const { loadConfig } = await import("../src/config.ts");
    const config = loadConfig(configPath);

    expect(config.claude_data_dir).toBe(path.join(tempHome, "claude"));
    expect(config.polling_interval_milliseconds).toBe(300000);
    expect(config.cost_mode).toBe("auto");
  });

  it("loads config with millisecond polling interval", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(configPath, baseConfigYaml().replace("polling_interval_milliseconds: 300000", "polling_interval_milliseconds: 2500"));
    const { loadConfig } = await import("../src/config.ts");
    const config = loadConfig(configPath);
    expect(config.polling_interval_milliseconds).toBe(2500);
  });

  it("throws when config file is missing", async () => {
    const { loadConfig } = await import("../src/config.ts");
    expect(() => loadConfig(path.join(tempDir, "missing.yaml"))).toThrow(/config file not found/);
  });

  it("throws when YAML root is not an object", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(configPath, `"string-root"`);
    const { loadConfig } = await import("../src/config.ts");
    expect(() => loadConfig(configPath)).toThrow(/config must be a YAML object/);
  });

  it("validates threshold ordering", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      `claude_data_dir: "~/claude"
polling_interval_milliseconds: 300000
timezone: "UTC"
cost_mode: "auto"
thresholds:
  daily:
    warning: 10
    critical: 10
  weekly:
    warning: 25
    critical: 50
  monthly:
    warning: 80
    critical: 150
notifications:
  console:
    enabled: true
  macos:
    enabled: false
    sound: false
  slack:
    enabled: false
    mention: ""
  email:
    enabled: false
    smtp_secure: false
notification_cooldown_minutes: 60
log_level: "info"
dashboard:
  refresh_interval_seconds: 60
`
    );
    const { loadConfig } = await import("../src/config.ts");
    expect(() => loadConfig(configPath)).toThrow(/warning must be less than critical/);
  });

  it("uses env fallback for slack webhook", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      `claude_data_dir: "~/claude"
polling_interval_milliseconds: 300000
timezone: "UTC"
cost_mode: "auto"
thresholds:
  daily:
    warning: 5
    critical: 10
  weekly:
    warning: 25
    critical: 50
  monthly:
    warning: 80
    critical: 150
notifications:
  console:
    enabled: true
  macos:
    enabled: false
    sound: false
  slack:
    enabled: true
    mention: "<!channel>"
  email:
    enabled: false
    smtp_secure: false
notification_cooldown_minutes: 60
log_level: "info"
dashboard:
  refresh_interval_seconds: 60
`
    );
    process.env.CCEYE_SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/X";
    const { loadConfig } = await import("../src/config.ts");
    const config = loadConfig(configPath);
    expect(config.notifications.slack.webhook_url).toBe("https://hooks.slack.com/services/T/B/X");
  });

  it("uses env fallback for smtp_pass when email notifications enabled", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      configPath,
      `claude_data_dir: "~/claude"
polling_interval_milliseconds: 300000
timezone: "UTC"
cost_mode: "auto"
thresholds:
  daily:
    warning: 5
    critical: 10
  weekly:
    warning: 25
    critical: 50
  monthly:
    warning: 80
    critical: 150
notifications:
  console:
    enabled: true
  macos:
    enabled: false
    sound: false
  slack:
    enabled: false
    mention: ""
  email:
    enabled: true
    smtp_host: "smtp.example.com"
    smtp_port: 587
    smtp_secure: false
    smtp_user: "user"
    from: "from@example.com"
    to: "to@example.com"
notification_cooldown_minutes: 60
log_level: "info"
dashboard:
  refresh_interval_seconds: 60
`
    );
    process.env.CCEYE_SMTP_PASS = "secret";
    const { loadConfig } = await import("../src/config.ts");
    const config = loadConfig(configPath);
    expect(config.notifications.email.smtp_pass).toBe("secret");
  });

  it("loads config via --config args", async () => {
    const configPath = path.join(tempDir, "config.yaml");
    fs.writeFileSync(configPath, baseConfigYaml());
    const { loadConfigFromArgs } = await import("../src/config.ts");
    const config = loadConfigFromArgs(["status", "--config", configPath]);
    expect(config.timezone).toBe("UTC");
  });
});
