import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRendererHeartbeat } from './rendererHeartbeat';

describe('renderer heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('keeps heartbeating after pagehide when Tauri does not emit pageshow', async () => {
    vi.useFakeTimers();
    const emit = vi.fn(async (_event: string, _payload?: unknown) => undefined);

    const stop = startRendererHeartbeat({ emit, isDesktop: true, windowLabel: 'main' });
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(emit).toHaveBeenCalledTimes(8);

    window.dispatchEvent(new Event('pageshow'));
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(9);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(11);

    stop();
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(11);
  });

  it('beats immediately when a hidden renderer returns to the foreground', async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const emit = vi.fn(async (_event: string, _payload?: unknown) => undefined);

    const stop = startRendererHeartbeat({ emit, isDesktop: true, windowLabel: 'main' });
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(2);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(2);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTicks();
    expect(emit).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(5);

    stop();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(5);
  });
});
