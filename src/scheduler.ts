export interface SchedulerLogger {
  warn(message: string): void;
  error?(message: string): void;
}

export class Scheduler {
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private logger: SchedulerLogger;
  private task: () => Promise<void>;

  constructor(intervalMs: number, task: () => Promise<void>, logger: SchedulerLogger) {
    this.intervalMs = intervalMs;
    this.task = task;
    this.logger = logger;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runTask();
    }, this.intervalMs);
    void this.runTask();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runTask(): Promise<void> {
    if (this.running) {
      this.logger.warn("previous poll still running, skipping this cycle");
      return;
    }
    this.running = true;
    try {
      await this.task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error?.(`polling task failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
