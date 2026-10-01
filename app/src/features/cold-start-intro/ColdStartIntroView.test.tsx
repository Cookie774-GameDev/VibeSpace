import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLD_START_INTRO_CROSSFADE_MS, COLD_START_INTRO_HARD_TIMEOUT_MS } from './introAsset';
import { ColdStartIntroView } from './ColdStartIntroView';

const native = vi.hoisted(() => ({
  main: {
    show: vi.fn(async () => undefined),
    unminimize: vi.fn(async () => undefined),
    setFocus: vi.fn(async () => undefined),
  },
  current: {
    label: 'cold-start-intro',
    close: vi.fn(async () => undefined),
  },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: vi.fn(async () => native.main),
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => native.current,
}));

describe('ColdStartIntroView recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reveals the main window when video playback never resolves or emits an event', async () => {
    render(<ColdStartIntroView />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        COLD_START_INTRO_HARD_TIMEOUT_MS + COLD_START_INTRO_CROSSFADE_MS,
      );
    });

    expect(native.main.show).toHaveBeenCalledTimes(1);
    expect(native.main.unminimize).toHaveBeenCalledTimes(1);
    expect(native.current.close).toHaveBeenCalledTimes(1);
  });

  it('continues the native handoff and closes the intro when one main-window step rejects', async () => {
    native.main.show.mockRejectedValueOnce(new Error('temporary show failure'));
    render(<ColdStartIntroView />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        COLD_START_INTRO_HARD_TIMEOUT_MS + COLD_START_INTRO_CROSSFADE_MS,
      );
    });

    expect(native.main.unminimize).toHaveBeenCalledTimes(1);
    expect(native.main.setFocus).toHaveBeenCalledTimes(1);
    expect(native.current.close).toHaveBeenCalledTimes(1);
  });

  it('skips only after three distinct non-repeating Escape keydowns', async () => {
    render(<ColdStartIntroView />);

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', repeat: false });
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', repeat: true });
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', repeat: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_START_INTRO_CROSSFADE_MS);
    });
    expect(native.main.show).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', repeat: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLD_START_INTRO_CROSSFADE_MS);
    });

    expect(native.main.show).toHaveBeenCalledTimes(1);
    expect(native.current.close).toHaveBeenCalledTimes(1);
  });
});
