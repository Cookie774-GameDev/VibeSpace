import { describe, expect, it, vi } from 'vitest';

import type { JarvisEvent } from '@/lib/jarvis/contracts/execution';

import { startJarvisTaskRunNotifications } from './taskRunNotifications';

const NOW = 1_784_435_200_000;

function event(seq: number, overrides: Partial<JarvisEvent> = {}): JarvisEvent {
  return {
    runId: 'jrun-alpha',
    seq,
    idempotencyKey: `event-${seq}`,
    type: 'run_state',
    status: 'running',
    title: 'PRIVATE EVENT TITLE',
    safeSummary: 'PRIVATE SAFE SUMMARY MUST NOT ENTER NOTIFICATION',
    sourceRefs: [],
    artifactIds: [],
    createdAt: NOW + seq,
    ...overrides,
  };
}

describe('canonical Jarvis task notifications', () => {
  it('emits generic copy once per canonical run/sequence transition', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const unsubscribe = vi.fn();
    const notify = vi.fn(
      async (_title: string, _body: string, _status: string, _completionIdentity?: string) =>
        undefined,
    );
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      notify,
    });

    listener(event(1, { status: 'awaiting_approval' }));
    listener(event(1, { status: 'awaiting_approval' }));
    listener(event(2, { status: 'partial' }));
    listener(event(3, { status: 'completed' }));
    listener(event(4, { status: 'failed' }));
    listener(event(5, { status: 'timed_out' }));
    listener(event(6, { status: 'cancelled' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(6));
    expect(notify.mock.calls.map((call) => call[0])).toEqual([
      'Jarvis task needs approval',
      'Jarvis task needs input',
      'Jarvis task completed',
      'Jarvis task failed',
      'Jarvis task timed out',
      'Jarvis task cancelled',
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(
      /PRIVATE EVENT TITLE|PRIVATE SAFE SUMMARY/,
    );
    expect(notify.mock.calls[2]?.[3]).toBe('jarvis-run:jrun-alpha');
    expect(notify.mock.calls[3]?.[3]).toBeUndefined();
    expect(notify.mock.calls[5]?.[3]).toBeUndefined();

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not notify for cancellation intent, signal delivery, handoff, or legacy hydration', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const notify = vi.fn(async () => undefined);
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
    });

    listener(event(1, { type: 'warning', status: 'cancellation_requested' }));
    listener(event(2, { type: 'warning', status: 'signal_delivered' }));
    listener(event(3, { type: 'warning', status: 'handoff_pending' }));
    listener(event(4, { type: 'run_state', status: 'running' }));

    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    stop();
  });

  it('never replays an immutable run/sequence transition after later journal traffic', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const notify = vi.fn();
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
    });

    for (let seq = 1; seq <= 5_001; seq += 1) {
      listener(event(seq, { status: 'completed' }));
    }
    listener(event(1, { status: 'completed' }));

    expect(notify).toHaveBeenCalledTimes(5_001);
    stop();
  });

  it('reports notification failures without breaking later canonical events', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const onError = vi.fn();
    const notify = vi
      .fn<(title: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('native notification unavailable'))
      .mockResolvedValue(undefined);
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
      onError,
    });

    listener(event(1, { status: 'completed' }));
    listener(event(2, { status: 'failed' }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    stop();
  });
});
