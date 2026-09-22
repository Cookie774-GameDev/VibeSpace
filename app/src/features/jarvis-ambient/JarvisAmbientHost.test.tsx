import { act, render, waitFor, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceStore } from '@/features/voice/store';
import { setJarvisPlaybackEnergy } from '@/features/voice/jarvisPlaybackEnergy';
import { useUIStore } from '@/stores/ui';
import { setJarvisInputEnergy } from './voiceEnergy';
import { JarvisAmbientHost, JarvisAmbientOverlayView } from './JarvisAmbientHost';

const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined);

const listen = vi.fn(
  async (_event: string, _listener: (event: { payload: unknown }) => void): Promise<() => void> =>
    () =>
      undefined,
);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

describe('JarvisAmbientHost', () => {
  it('keeps idle hidden in the browser fallback without native IPC', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    useUIStore.setState({ voiceModalOpen: true });
    const view = render(<JarvisAmbientHost />);
    await waitFor(() =>
      expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-active')).toBe('false'),
    );
    expect(invoke).not.toHaveBeenCalled();
    act(() => useUIStore.setState({ voiceModalOpen: false }));
    await waitFor(() =>
      expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-active')).toBe('false'),
    );
    view.unmount();
  });

  it('prewarms the native Aura when voice mode opens and releases it on close', async () => {
    useUIStore.setState({ voiceModalOpen: true });
    const view = render(<JarvisAmbientHost />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({
          snapshot: expect.objectContaining({ state: 'idle', active: false, prewarm: true }),
        }),
      ),
    );

    invoke.mockClear();
    act(() => useUIStore.getState().setVoiceModalOpen(false));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({
          snapshot: expect.objectContaining({ state: 'idle', active: false }),
        }),
      ),
    );
    expect((invoke.mock.calls.at(-1)?.[1] as { snapshot: { prewarm?: boolean } }).snapshot.prewarm).toBeUndefined();
    view.unmount();
  });
  beforeEach(() => {
    invoke.mockClear();
    useVoiceStore.getState().reset();
    useUIStore.setState({ voiceModalOpen: false });
    setJarvisInputEnergy(0);
    setJarvisPlaybackEnergy(0);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('publishes real user and Jarvis speech energy to the native aura', async () => {
    useUIStore.setState({ voiceModalOpen: true });
    const view = render(<JarvisAmbientHost />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());

    act(() => {
      useVoiceStore.getState().setState('listening');
      setJarvisInputEnergy(0.74);
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({
          snapshot: expect.objectContaining({ state: 'listening', energy: 0.74 }),
        }),
      ),
    );

    act(() => {
      useVoiceStore.getState().setState('speaking');
      setJarvisPlaybackEnergy(0.61);
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({
          snapshot: expect.objectContaining({ state: 'speaking', energy: 0.61 }),
        }),
      ),
    );
    view.unmount();
  });

  it('wakes the physical-screen aura only when listening starts', async () => {
    render(<JarvisAmbientHost />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    invoke.mockClear();

    act(() => {
      useUIStore.getState().setVoiceModalOpen(true);
      useVoiceStore.getState().setState('listening');
    });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({
          snapshot: expect.objectContaining({ state: 'listening', source: 'voice', active: true }),
        }),
      ),
    );
  });

  it('coalesces queued states so delayed IPC cannot replay obsolete speech after close', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const view = render(<JarvisAmbientHost />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(invoke).toHaveBeenCalledOnce();
      await act(async () => {
        useUIStore.getState().setVoiceModalOpen(true);
        useVoiceStore.getState().setState('listening');
        await vi.advanceTimersByTimeAsync(40);
        useVoiceStore.getState().setState('speaking');
        await vi.advanceTimersByTimeAsync(40);
        useUIStore.getState().setVoiceModalOpen(false);
        useVoiceStore.getState().setState('idle');
        await vi.advanceTimersByTimeAsync(40);
        finish();
        await vi.advanceTimersByTimeAsync(0);
      });
      const states = invoke.mock.calls.map(
        (call) => (call[1] as { snapshot: { state: string } }).snapshot.state,
      );
      expect(states).toEqual(['idle', 'idle']);
      expect(invoke).toHaveBeenLastCalledWith(
        'set_jarvis_ambient_snapshot',
        expect.objectContaining({ snapshot: expect.objectContaining({ active: false }) }),
      );
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('never publishes a queued active snapshot after the host unmounts', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    useUIStore.getState().setVoiceModalOpen(true);
    useVoiceStore.getState().setState('listening');
    const view = render(<JarvisAmbientHost />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        useVoiceStore.getState().setState('speaking');
        await vi.advanceTimersByTimeAsync(40);
      });
      view.unmount();
      await act(async () => {
        finish();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        invoke.mock.calls
          .filter(([command]) => command === 'set_jarvis_ambient_snapshot')
          .slice(1)
          .some(
            (call) => (call[1] as { snapshot: { state: string } }).snapshot.state === 'speaking',
          ),
      ).toBe(false);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('does not invoke native commands in an ordinary browser test surface', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    render(<JarvisAmbientHost />);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('native Aura renderer lifecycle', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    listen.mockReset().mockResolvedValue(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a newer event when delayed renderer-ready returns an older snapshot', async () => {
    let finish!: (value: unknown) => void;
    let deliver!: (event: { payload: unknown }) => void;
    listen.mockImplementationOnce(async (_name, handler) => {
      deliver = handler;
      return () => undefined;
    });
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<JarvisAmbientOverlayView />);
    try {
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('jarvis_ambient_renderer_ready'));
      await act(async () => {
        deliver({
          payload: {
            revision: 30,
            state: 'speaking',
            source: 'voice',
            energy: 0.7,
            observedAt: 30,
            active: true,
          },
        });
        finish({
          revision: 20,
          state: 'listening',
          source: 'voice',
          energy: 0.2,
          observedAt: 20,
          active: true,
        });
      });
      expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-jarvis-ambient-state')).toBe(
        'speaking',
      );
      expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-energy')).toBe('0.70');
    } finally {
      view.unmount();
    }
  });

  it('releases a listener registered after unmount and never announces renderer readiness', async () => {
    let finish!: (off: () => void) => void;
    const off = vi.fn();
    listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<JarvisAmbientOverlayView />);
    await waitFor(() => expect(listen).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => {
      finish(off);
    });
    expect(off).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('jarvis_ambient_renderer_ready');
  });
});
