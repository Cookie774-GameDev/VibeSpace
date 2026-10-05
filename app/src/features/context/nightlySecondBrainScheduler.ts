import {
  isNightlySecondBrainRunDue,
  mostRecentNightlySecondBrainRun,
  nextNightlySecondBrainRun,
  type SecondBrainSchedule,
} from './nightlySecondBrain';

const MAX_TIMEOUT_MS = 2_147_000_000;

export interface NightlySecondBrainSchedulerPorts {
  now(): Date;
  lastScheduledFor(): number | undefined;
  run(scheduledFor: number): Promise<void | boolean>;
  schedule?(): SecondBrainSchedule;
  canRun?(): boolean;
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
    let retry = false;
    if (
      this.ports.canRun?.() !== false &&
      isNightlySecondBrainRunDue({
        now,
        lastScheduledFor: this.ports.lastScheduledFor(),
        schedule: this.ports.schedule?.(),
      })
    ) {
      this.running = true;
      try {
        retry =
          (await this.ports.run(
            mostRecentNightlySecondBrainRun(now, this.ports.schedule?.()).getTime(),
          )) === false;
      } catch {
        retry = true;
        // The runtime records its own bounded failure state. A scheduler-level
        // failure must not strand the canonical timer for the rest of the app
        // session.
      } finally {
        this.running = false;
      }
    }
    if (this.stopped) return;
    const current = this.ports.now();
    const delay = retry
      ? 5 * 60_000
      : Math.max(
          1_000,
          nextNightlySecondBrainRun(current, this.ports.schedule?.()).getTime() - current.getTime(),
        );
    this.timer = this.ports.setTimer(
      () => {
        this.timer = undefined;
        void this.checkAndSchedule();
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
  }
}
