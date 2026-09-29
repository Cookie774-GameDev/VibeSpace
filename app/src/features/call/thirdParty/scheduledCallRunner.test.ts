import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createScheduledCallRunner, startScheduledCallRunner } from './scheduledCallRunner';
import type { ScheduledThirdPartyCall } from './types';

const cloudClient = vi.hoisted(() => ({ getSupabaseClient: vi.fn() }));
vi.mock('@/lib/supabase/client', () => cloudClient);

const due: ScheduledThirdPartyCall = {
  id: 'schedule-due',
  jobId: 'job-due',
  status: 'scheduled',
  scheduledFor: '2026-08-30T15:00:00.000Z',
  revision: 4,
  destinationDisplayName: 'Clinic',
  destinationMasked: '+* (***) ***-0110',
  purpose: 'Ask about office hours.',
};

describe('scheduled call app runner', () => {
  it('is started and stopped by the ordinary app lifecycle', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toContain('stopScheduledCallRunner = startScheduledCallRunner()');
    expect(app).toContain('stopScheduledCallRunner?.()');
  });

  it('skips cloud listing without a session and resumes after sign-in', async () => {
    vi.useFakeTimers();
    let signedIn = false;
    const invoke = vi.fn().mockResolvedValue({ data: { schedules: [] }, error: null });
    cloudClient.getSupabaseClient.mockReturnValue({
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: signedIn ? { user: { id: 'disposable-account' } } : null },
          error: null,
        })),
      },
      functions: { invoke },
    });

    const stop = startScheduledCallRunner();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).not.toHaveBeenCalled();

      signedIn = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(invoke).toHaveBeenCalledExactlyOnceWith('third-party-call', {
        body: { action: 'list-scheduled' },
      });

      signedIn = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      vi.useRealTimers();
      cloudClient.getSupabaseClient.mockReset();
    }
  });

  it('recovers due scheduled and expired-dispatch claims but skips future and terminal rows', async () => {
    const dispatchScheduled = vi.fn().mockResolvedValue(undefined);
    const client = {
      listScheduled: vi
        .fn()
        .mockResolvedValue([
          due,
          { ...due, id: 'schedule-recover', status: 'dispatching', revision: 8 },
          { ...due, id: 'schedule-future', scheduledFor: '2026-09-02T15:00:00.000Z' },
          { ...due, id: 'schedule-cancelled', status: 'cancelled' },
        ]),
      dispatchScheduled,
    };
    const runner = createScheduledCallRunner(client, {
      now: () => new Date('2026-08-31T15:00:00.000Z').getTime(),
      intervalMs: 60_000,
    });

    await runner.runNow();
    runner.stop();

    expect(dispatchScheduled.mock.calls).toEqual([
      ['schedule-due', 4],
      ['schedule-recover', 8],
    ]);
  });

  it('serializes overlapping ticks so one observed revision is never dispatched twice', async () => {
    let releaseList: ((rows: ScheduledThirdPartyCall[]) => void) | undefined;
    const listScheduled = vi.fn().mockImplementation(
      () =>
        new Promise<ScheduledThirdPartyCall[]>((resolve) => {
          releaseList = resolve;
        }),
    );
    const dispatchScheduled = vi.fn().mockResolvedValue(undefined);
    const runner = createScheduledCallRunner(
      { listScheduled, dispatchScheduled },
      { now: () => Date.parse('2026-08-31T15:00:00.000Z'), intervalMs: 60_000 },
    );

    const first = runner.runNow();
    const second = runner.runNow();
    await Promise.resolve();
    expect(listScheduled).toHaveBeenCalledTimes(1);
    releaseList?.([due]);
    await Promise.all([first, second]);
    runner.stop();

    expect(dispatchScheduled).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch late list results after lifecycle stop', async () => {
    let releaseList: ((rows: ScheduledThirdPartyCall[]) => void) | undefined;
    const dispatchScheduled = vi.fn();
    const runner = createScheduledCallRunner(
      {
        listScheduled: () =>
          new Promise<ScheduledThirdPartyCall[]>((resolve) => {
            releaseList = resolve;
          }),
        dispatchScheduled,
      },
      { now: () => Date.parse('2026-08-31T15:00:00.000Z'), intervalMs: 60_000 },
    );

    const pending = runner.runNow();
    await Promise.resolve();
    runner.stop();
    releaseList?.([due]);
    await pending;

    expect(dispatchScheduled).not.toHaveBeenCalled();
  });
});
