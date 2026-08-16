import fs from "fs";
import os from "os";
import path from "path";
import yaml from "yaml";
import { z } from "zod";
import { protectPrivateDirectory, protectPrivateFile } from "./file-permissions.js";

const thresholdsSchema = z.object({
  warning: z.number().nonnegative(),
  critical: z.number().nonnegative(),
});

const notificationConfigSchema = z.object({
  console: z.object({
    enabled: z.boolean(),
  }),
  macos: z.object({
    enabled: z.boolean(),
    sound: z.boolean(),
  }),
  slack: z.object({
    enabled: z.boolean(),
    webhook_url: z.string().url().optional(),
    mention: z.string().optional().default(""),
  }),
  email: z.object({
    enabled: z.boolean(),
    smtp_host: z.string().optional(),
    smtp_port: z.number().int().positive().optional(),
    smtp_secure: z.boolean(),
    smtp_user: z.string().optional(),
    smtp_pass: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
});

const dashboardSchema = z.object({
  refresh_interval_seconds: z.number().int().positive(),
});

const storageSchema = z.object({
  database_path: z.string().min(1).default("~/.config/cceye/cceye.db"),
});

const pricingSchema = z.object({
  aliases: z.record(z.string(), z.string()).default({}),
});

const billingSchema = z.object({
  anthropic: z.object({
    enabled: z.boolean().default(false),
    api_key_env: z.string().min(1).default("CCEYE_ANTHROPIC_ADMIN_API_KEY"),
  }),
});

const alertsSchema = z.object({
  notify_on_recovery: z.boolean().default(false),
  max_retries: z.number().int().positive().default(5),
});

const configSchema = z
  .object({
    claude_data_dir: z.string().min(1).default("~/.claude/projects"),
    polling_interval_milliseconds: z.number().int().positive().optional(),
    timezone: z.string().min(1).refine(isValidTimezone, "must be a valid IANA timezone"),
    cost_mode: z.enum(["auto", "calculate", "display"]),
    thresholds: z.object({
      daily: thresholdsSchema,
      weekly: thresholdsSchema,
      monthly: thresholdsSchema,
    }),
    notifications: notificationConfigSchema,
    notification_cooldown_minutes: z.number().int().positive(),
    log_level: z.enum(["debug", "info", "warn", "error"]),
    dashboard: dashboardSchema,
    storage: storageSchema.default({ database_path: "~/.config/cceye/cceye.db" }),
    pricing: pricingSchema.default({ aliases: {} }),
    billing: billingSchema.default({ anthropic: { enabled: false, api_key_env: "CCEYE_ANTHROPIC_ADMIN_API_KEY" } }),
    alerts: alertsSchema.default({ notify_on_recovery: false, max_retries: 5 }),
  })
  .superRefine((value, context) => {
    if (value.polling_interval_milliseconds === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["polling_interval_milliseconds"],
        message: "polling_interval_milliseconds is required",
      });
    }

    const windows = ["daily", "weekly", "monthly"] as const;
    for (const window of windows) {
      const threshold = value.thresholds[window];
      if (threshold.warning >= threshold.critical) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thresholds", window],
          message: `warning must be less than critical for ${window}`,
        });
      }
    }

    if (value.notifications.slack.enabled && !value.notifications.slack.webhook_url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notifications", "slack", "webhook_url"],
        message: "webhook_url is required when slack notifications are enabled",
      });
    }

    if (value.notifications.email.enabled) {
      const email = value.notifications.email;
      const missing = [
        !email.smtp_host ? "smtp_host" : null,
        !email.smtp_port ? "smtp_port" : null,
        !email.smtp_user ? "smtp_user" : null,
        !email.smtp_pass ? "smtp_pass" : null,
        !email.from ? "from" : null,
        !email.to ? "to" : null,
      ].filter(Boolean);
      if (missing.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["notifications", "email"],
          message: `missing required email fields: ${missing.join(", ")}`,
        });
      }
    }

    const normalizedAliases = Object.fromEntries(
      Object.entries(value.pricing.aliases).map(([alias, target]) => [alias.trim().toLowerCase(), target.trim().toLowerCase()])
    );
    for (const alias of Object.keys(normalizedAliases)) {
      const seen = new Set<string>();
      let current: string | undefined = alias;
      while (current && normalizedAliases[current]) {
        if (seen.has(current)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pricing", "aliases", alias],
            message: "pricing aliases must not contain cycles",
          });
          break;
        }
        seen.add(current);
        current = normalizedAliases[current];
      }
    }
  })
  .transform((value) => ({
    ...value,
    polling_interval_milliseconds: value.polling_interval_milliseconds!,
  }));

export type Config = z.infer<typeof configSchema>;

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const defaultConfigPath = path.join(os.homedir(), ".config", "cceye", "config.yaml");

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length ? issue.path.join(".") : "config";
      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

export function resolveConfigPath(argPath?: string): string {
  return argPath ?? defaultConfigPath;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function loadConfig(argPath?: string): Config {
  const configPath = resolveConfigPath(argPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }

  if (path.resolve(path.dirname(configPath)) === path.resolve(path.join(os.homedir(), ".config", "cceye"))) {
    protectPrivateDirectory(path.dirname(configPath));
  }
  protectPrivateFile(configPath);
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    const document = yaml.parseDocument(raw);
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("config document contains YAML diagnostics");
    }
    parsed = document.toJS() ?? {};
  } catch {
    throw new Error("invalid config YAML");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("config must be a YAML object");
  }

  const parsedConfig = parsed as Record<string, unknown>;
  const notifications = asRecord(parsedConfig.notifications);
  const slack = asRecord(notifications?.slack);
  const email = asRecord(notifications?.email);

  if (slack?.enabled === true && !slack.webhook_url) {
    const envWebhook = process.env.CCEYE_SLACK_WEBHOOK_URL;
    if (envWebhook) {
      parsedConfig.notifications = {
        ...notifications,
        slack: { ...slack, webhook_url: envWebhook },
      };
    }
  }

  if (email?.enabled === true && !email.smtp_pass) {
    const envPass = process.env.CCEYE_SMTP_PASS;
    if (envPass) {
      parsedConfig.notifications = {
        ...asRecord(parsedConfig.notifications),
        email: { ...email, smtp_pass: envPass },
      };
    }
  }

  const result = configSchema.safeParse(parsedConfig);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }

  return {
    ...result.data,
    claude_data_dir: expandHome(result.data.claude_data_dir),
    storage: {
      ...result.data.storage,
      database_path: expandHome(result.data.storage.database_path),
    },
    pricing: result.data.pricing,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

export function loadConfigFromArgs(args: string[]): Config {
  const configIndex = args.findIndex((arg) => arg === "--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  return loadConfig(configPath);
}
