import {
  isNightlySecondBrainRunDue,
  mostRecentNightlySecondBrainRun,
  nextNightlySecondBrainRun,
} from './nightlySecondBrain';

const MAX_TIMEOUT_MS = 2_147_000_000;

export interface NightlySecondBrainSchedulerPorts {
  now(): Date;
  lastScheduledFor(): number | undefined;
  run(scheduledFor: number): Promise<void>;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export class NightlySecondBrainScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;

  constructor(private readonly ports: NightlySecondBrainSchedulerPorts) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.checkAndSchedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.ports.clearTimer(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.ports.clearTimer(this.timer);
    this.timer = undefined;
    void this.checkAndSchedule();
  }

  private async checkAndSchedule(): Promise<void> {
    if (this.stopped || this.running) return;
    const now = this.ports.now();
    if (
      isNightlySecondBrainRunDue({
        now,
        lastScheduledFor: this.ports.lastScheduledFor(),
      })
    ) {
      this.running = true;
      try {
        await this.ports.run(mostRecentNightlySecondBrainRun(now).getTime());
      } catch {
        // The runtime records its own bounded failure state. A scheduler-level
        // failure must not strand the canonical timer for the rest of the app
        // session.
      } finally {
        this.running = false;
      }
    }
    if (this.stopped) return;
    const current = this.ports.now();
    const delay = Math.max(1_000, nextNightlySecondBrainRun(current).getTime() - current.getTime());
    this.timer = this.ports.setTimer(
      () => {
        this.timer = undefined;
        void this.checkAndSchedule();
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
  }
}
