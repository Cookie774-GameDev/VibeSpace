import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRendererHeartbeat } from './rendererHeartbeat';

describe('renderer heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing in a normal browser preview', () => {
    const emit = vi.fn(async (_event: string, _payload?: unknown) => undefined);

    const stop = startRendererHeartbeat({ emit, isDesktop: false });

    expect(emit).not.toHaveBeenCalled();
    stop();
  });

  it('does not let auxiliary windows mask a failed main renderer', () => {
    const emit = vi.fn(async (_event: string, _payload?: unknown) => undefined);

    const stop = startRendererHeartbeat({
      emit,
      isDesktop: true,
      windowLabel: 'taskbar-usage',
    });

    expect(emit).not.toHaveBeenCalled();
    stop();
  });

  it('emits immediately, continues at a bounded cadence, and cleans up', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async (_event: string, _payload?: unknown) => undefined);

    const stop = startRendererHeartbeat({ emit, isDesktop: true, windowLabel: 'main' });
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(emit).toHaveBeenCalledTimes(4);
    const payloads = emit.mock.calls.map((call) => call[1] as { generation?: string });
    expect(payloads.every((payload) => typeof payload.generation === 'string')).toBe(true);
    expect(new Set(payloads.map((payload) => payload.generation)).size).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(4);
  });
});
