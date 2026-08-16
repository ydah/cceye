import fs from "fs";
import os from "os";
import path from "path";
import yaml from "yaml";
import { z } from "zod";

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

const configSchema = z
  .object({
    claude_data_dir: z.string().min(1).default("~/.claude/projects"),
    polling_interval_milliseconds: z.number().int().positive().optional(),
    timezone: z.string().min(1),
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
  })
  .transform((value) => ({
    ...value,
    polling_interval_milliseconds: value.polling_interval_milliseconds!,
  }));

export type Config = z.infer<typeof configSchema>;

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

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.parse(raw) ?? {};
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("config must be a YAML object");
  }

  if (parsed.notifications?.slack?.enabled && !parsed.notifications.slack.webhook_url) {
    const envWebhook = process.env.CCEYE_SLACK_WEBHOOK_URL;
    if (envWebhook) {
      parsed.notifications.slack.webhook_url = envWebhook;
    }
  }

  if (parsed.notifications?.email?.enabled && !parsed.notifications.email.smtp_pass) {
    const envPass = process.env.CCEYE_SMTP_PASS;
    if (envPass) {
      parsed.notifications.email.smtp_pass = envPass;
    }
  }

  const result = configSchema.safeParse(parsed);
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
  };
}

export function loadConfigFromArgs(args: string[]): Config {
  const configIndex = args.findIndex((arg) => arg === "--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  return loadConfig(configPath);
}
