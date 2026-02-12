import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert, NotificationConfig } from "../src/notifiers/types.ts";

const alert: Alert = {
  level: "warning",
  window: "daily",
  currentCost: 12.34,
  threshold: 10,
  timestamp: new Date("2026-02-11T10:00:00.000Z"),
};

function baseConfig(): NotificationConfig {
  return {
    notifications: {
      console: { enabled: true },
      macos: { enabled: true, sound: true },
      slack: { enabled: true, webhook_url: "https://hooks.slack.com/services/T/B/X", mention: "<!channel>" },
      email: {
        enabled: true,
        smtp_host: "smtp.example.com",
        smtp_port: 587,
        smtp_secure: false,
        smtp_user: "user",
        smtp_pass: "pass",
        from: "from@example.com",
        to: "a@example.com,b@example.com",
      },
    },
  };
}

function alertWithWindow(window: string): Alert {
  return { ...alert, window } as unknown as Alert;
}

describe("notifiers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  it("ConsoleNotifier logs warning/critical messages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ConsoleNotifier } = await import("../src/notifiers/console.ts");
    const notifier = new ConsoleNotifier();
    await notifier.send(alert);
    await notifier.send({ ...alert, level: "critical", window: "monthly" });

    expect(logSpy).toHaveBeenCalledTimes(2);
    const first = String(logSpy.mock.calls[0]?.[0]);
    expect(first).toContain("WARNING");
    expect(first).toContain("Daily");
  });

  it("SlackNotifier posts payload when enabled", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { SlackNotifier } = await import("../src/notifiers/slack.ts");

    const notifier = new SlackNotifier(baseConfig());
    await notifier.send(alert);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.attachments[0].blocks[0].text.text).toContain("<!channel>");
  });

  it("SlackNotifier handles mention-less config and fallback window labels", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { SlackNotifier } = await import("../src/notifiers/slack.ts");

    const cfg = baseConfig();
    delete cfg.notifications.slack.mention;
    const notifier = new SlackNotifier(cfg);

    await notifier.send({ ...alert, level: "critical", window: "monthly" });
    await notifier.send(alertWithWindow("custom-window"));

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const firstText = String(firstBody.attachments[0].blocks[0].text.text);
    const secondText = String(secondBody.attachments[0].blocks[0].text.text);

    expect(firstText).toContain("CRITICAL Monthly");
    expect(firstText.startsWith("<!channel>")).toBe(false);
    expect(secondText).toContain("WARNING custom-window");
  });

  it("SlackNotifier skips send when disabled or webhook missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { SlackNotifier } = await import("../src/notifiers/slack.ts");

    const cfg = baseConfig();
    cfg.notifications.slack.enabled = false;
    await new SlackNotifier(cfg).send(alert);

    cfg.notifications.slack.enabled = true;
    delete cfg.notifications.slack.webhook_url;
    await new SlackNotifier(cfg).send(alert);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SlackNotifier throws when webhook responds with error status", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { SlackNotifier } = await import("../src/notifiers/slack.ts");

    const notifier = new SlackNotifier(baseConfig());
    await expect(notifier.send(alert)).rejects.toThrow("slack webhook request failed with status 500");
  });

  it("MacosNotifier executes osascript only when enabled on macOS", async () => {
    const execMock = vi.fn((_: string, cb: (err?: Error | null) => void) => cb(null));
    vi.doMock("child_process", () => ({ exec: execMock }));
    const { MacosNotifier } = await import("../src/notifiers/macos.ts");

    Object.defineProperty(process, "platform", { value: "darwin" });
    const notifier = new MacosNotifier(baseConfig());
    await notifier.send(alert);
    expect(execMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(process, "platform", { value: "linux" });
    const notifier2 = new MacosNotifier(baseConfig());
    await notifier2.send(alert);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("MacosNotifier builds command text for each window and rejects osascript errors", async () => {
    const execMock = vi
      .fn()
      .mockImplementationOnce((_: string, cb: (err?: Error | null) => void) => cb(null))
      .mockImplementationOnce((_: string, cb: (err?: Error | null) => void) => cb(null))
      .mockImplementationOnce((_: string, cb: (err?: Error | null) => void) => cb(new Error("osascript failed")));
    vi.doMock("child_process", () => ({ exec: execMock }));
    const { MacosNotifier } = await import("../src/notifiers/macos.ts");

    Object.defineProperty(process, "platform", { value: "darwin" });
    const cfg = baseConfig();
    cfg.notifications.macos.sound = false;
    const notifier = new MacosNotifier(cfg);

    await notifier.send({ ...alert, level: "critical", window: "weekly" });
    await notifier.send({ ...alert, window: "monthly" });
    await expect(notifier.send(alertWithWindow("custom-window"))).rejects.toThrow("osascript failed");

    const weeklyCommand = String(execMock.mock.calls[0]?.[0]);
    const monthlyCommand = String(execMock.mock.calls[1]?.[0]);
    const fallbackCommand = String(execMock.mock.calls[2]?.[0]);
    expect(weeklyCommand).toContain("CRITICAL");
    expect(weeklyCommand).toContain("Weekly cost");
    expect(weeklyCommand).not.toContain('sound name "Funk"');
    expect(monthlyCommand).toContain("Monthly cost");
    expect(fallbackCommand).toContain("custom-window cost");
  });

  it("EmailNotifier builds transport and sends email", async () => {
    const sendMail = vi.fn(async () => undefined);
    const createTransport = vi.fn(() => ({ sendMail }));
    vi.doMock("nodemailer", () => ({
      default: { createTransport },
      createTransport,
    }));
    const { EmailNotifier } = await import("../src/notifiers/email.ts");

    const notifier = new EmailNotifier(baseConfig());
    await notifier.send({ ...alert, level: "critical", window: "weekly" });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const args = sendMail.mock.calls[0]?.[0];
    expect(args.subject).toContain("CRITICAL");
    expect(args.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("EmailNotifier skips transport when disabled or required config is missing", async () => {
    const sendMail = vi.fn(async () => undefined);
    const createTransport = vi.fn(() => ({ sendMail }));
    vi.doMock("nodemailer", () => ({
      default: { createTransport },
      createTransport,
    }));
    const { EmailNotifier } = await import("../src/notifiers/email.ts");

    const disabled = baseConfig();
    disabled.notifications.email.enabled = false;
    await new EmailNotifier(disabled).send(alert);

    const incomplete = baseConfig();
    delete incomplete.notifications.email.smtp_host;
    await new EmailNotifier(incomplete).send(alert);

    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("EmailNotifier formats Daily/Monthly and fallback windows", async () => {
    const sendMail = vi.fn(async () => undefined);
    const createTransport = vi.fn(() => ({ sendMail }));
    vi.doMock("nodemailer", () => ({
      default: { createTransport },
      createTransport,
    }));
    const { EmailNotifier } = await import("../src/notifiers/email.ts");

    const notifier = new EmailNotifier(baseConfig());
    await notifier.send({ ...alert, window: "daily" });
    await notifier.send({ ...alert, level: "critical", window: "monthly" });
    await notifier.send(alertWithWindow("custom-window"));

    const subjects = sendMail.mock.calls.map((entry) => String(entry[0]?.subject));
    expect(subjects.some((subject) => subject.includes("Daily"))).toBe(true);
    expect(subjects.some((subject) => subject.includes("Monthly"))).toBe(true);
    expect(subjects.some((subject) => subject.includes("custom-window"))).toBe(true);
  });

  it("NotificationRouter returns only fulfilled notifier channels", async () => {
    class MockConsoleNotifier {
      name = "console";
      send = vi.fn(async () => undefined);
    }
    class MockMacosNotifier {
      name = "macos";
      send = vi.fn(async () => {
        throw new Error("boom");
      });
    }
    class MockSlackNotifier {
      name = "slack";
      send = vi.fn(async () => undefined);
    }
    class MockEmailNotifier {
      name = "email";
      send = vi.fn(async () => undefined);
    }

    vi.doMock("../src/notifiers/console.ts", () => ({ ConsoleNotifier: MockConsoleNotifier }));
    vi.doMock("../src/notifiers/macos.ts", () => ({ MacosNotifier: MockMacosNotifier }));
    vi.doMock("../src/notifiers/slack.ts", () => ({ SlackNotifier: MockSlackNotifier }));
    vi.doMock("../src/notifiers/email.ts", () => ({ EmailNotifier: MockEmailNotifier }));

    const { NotificationRouter } = await import("../src/notifiers/index.ts");
    const router = new NotificationRouter(baseConfig());
    const channels = await router.send(alert);

    expect(channels.sort()).toEqual(["console", "email", "slack"]);
  });
});
