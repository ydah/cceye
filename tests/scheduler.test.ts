import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchedulerLogger } from "../src/scheduler.ts";

describe("Scheduler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules interval and runs immediately", async () => {
    const { Scheduler } = await import("../src/scheduler.ts");
    const task = vi.fn(async () => undefined);
    const logger: SchedulerLogger = { warn: vi.fn() };
    const scheduler = new Scheduler(5, task, logger);

    scheduler.start();
    await Promise.resolve();

    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("skips overlapping runs and logs warning", async () => {
    const { Scheduler } = await import("../src/scheduler.ts");
    let resolveTask: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        })
    );
    const logger: SchedulerLogger = { warn: vi.fn() };
    const scheduler = new Scheduler(1, task, logger);
    scheduler.start();

    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(task).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("previous poll still running, skipping this cycle");

    resolveTask?.();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("stops interval task", async () => {
    const { Scheduler } = await import("../src/scheduler.ts");
    const task = vi.fn(async () => undefined);
    const scheduler = new Scheduler(2, task, { warn: vi.fn() });
    scheduler.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("logs task errors and keeps scheduler alive", async () => {
    const { Scheduler } = await import("../src/scheduler.ts");
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);
    const logger: SchedulerLogger = { warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler(3, task, logger);

    scheduler.start();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith("polling task failed: network down");

    await vi.advanceTimersByTimeAsync(3);
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
