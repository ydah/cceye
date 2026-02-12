export interface Alert {
  level: "warning" | "critical";
  window: "daily" | "weekly" | "monthly";
  currentCost: number;
  threshold: number;
  timestamp: Date;
}

export interface Notifier {
  name: string;
  send(alert: Alert): Promise<void>;
}

export interface NotificationConfig {
  notifications: {
    console: {
      enabled: boolean;
    };
    macos: {
      enabled: boolean;
      sound: boolean;
    };
    slack: {
      enabled: boolean;
      webhook_url?: string | undefined;
      mention?: string | undefined;
    };
    email: {
      enabled: boolean;
      smtp_host?: string | undefined;
      smtp_port?: number | undefined;
      smtp_secure: boolean;
      smtp_user?: string | undefined;
      smtp_pass?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    };
  };
}
