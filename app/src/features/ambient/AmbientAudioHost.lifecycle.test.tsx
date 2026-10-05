import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmbientAudioEngine } from './ambientAudio';
import { createDefaultMusicMix } from './music-studio/musicProject';

const state = vi.hoisted(() => ({
  ui: {
    ambient: false,
    ambientActive: false,
    ambientAlwaysPlay: true,
    ambientDrone: false,
    ambientTrack: 'music-1',
    ambientVolume: 42,
  },
  project: {
    clips: [] as import('./music-studio/musicProject').MusicClip[],
    enabledForAmbient: true,
    loop: false,
  },
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign((selector: (value: typeof state.ui) => unknown) => selector(state.ui), {
    getState: () => state.ui,
  }),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (value: { plan: string }) => unknown) => selector({ plan: 'free' }),
}));
vi.mock('@/lib/admin', () => ({ useAppAdmin: () => false }));
vi.mock('@/lib/entitlements', () => ({ effectivePlan: (plan: string) => plan }));
vi.mock('./music-studio/musicProject', async (original) => ({
  ...(await original<typeof import('./music-studio/musicProject')>()),
  useMusicProjectStore: (selector: (value: typeof state.project) => unknown) =>
    selector(state.project),
}));

import { AmbientAudioHost } from './AmbientAudioHost';

class FixtureAudio extends EventTarget {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 4;
  volume = 1;
  playbackRate = 1;
  loop = false;
  paused = true;
  readyState = 1;
  error: MediaError | null = null;
  load = vi.fn();
  removeAttribute = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
}

let audio: FixtureAudio;
beforeEach(() => {
  state.ui.ambientVolume = 42;
  state.ui.ambientAlwaysPlay = true;
  state.project.clips = createDefaultMusicMix().slice(0, 1);
  state.project.loop = false;
  state.project.enabledForAmbient = true;
  audio = new FixtureAudio();
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        return audio;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  AmbientAudioEngine.getInstance().dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function settle() {
  await act(async () => {
    for (let count = 0; count < 8; count++) await Promise.resolve();
  });
}
function interact() {
  act(() => {
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  });
}

describe('ambient host real-engine lifecycle', () => {
  it('keeps a completed non-looping mix stopped after ordinary pointer and keyboard input', async () => {
    render(<AmbientAudioHost />);
    await settle();
    act(() => audio.dispatchEvent(new Event('ended')));
    expect(AmbientAudioEngine.getInstance().isPlaying()).toBe(false);
    interact();
    await settle();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(true);
  });

  it('preserves explicit pause across unrelated input and allows deliberate resume', async () => {
    render(<AmbientAudioHost />);
    await settle();
    audio.currentTime = 2;
    act(() => AmbientAudioEngine.getInstance().pause());
    interact();
    await settle();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(true);
    act(() => AmbientAudioEngine.getInstance().playProject(state.project.clips, false, 42));
    await settle();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(2);
    expect(audio.paused).toBe(false);
  });

  it('retries a blocked autoplay exactly once on a user gesture and then leaves playback alone', async () => {
    audio.play.mockRejectedValueOnce(new DOMException('User gesture required', 'NotAllowedError'));
    render(<AmbientAudioHost />);
    await settle();
    expect(AmbientAudioEngine.getInstance().getLoadStatus()).toMatchObject({ state: 'error' });
    act(() => window.dispatchEvent(new Event('pointerdown')));
    await settle();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(AmbientAudioEngine.getInstance().getLoadStatus()).toMatchObject({ state: 'playing' });
    interact();
    await settle();
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('changes volume without restarting a completed non-looping mix', async () => {
    const view = render(<AmbientAudioHost />);
    await settle();
    act(() => audio.dispatchEvent(new Event('ended')));
    state.ui.ambientVolume = 0;
    view.rerender(<AmbientAudioHost />);
    await settle();
    expect(audio.volume).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(true);
  });

  it('keeps a replacement source playing when an earlier play promise rejects late', async () => {
    let rejectOld!: (error: Error) => void;
    audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectOld = reject;
        }),
    );
    const view = render(<AmbientAudioHost />);
    state.project.clips = createDefaultMusicMix().slice(1, 2);
    view.rerender(<AmbientAudioHost />);
    await settle();
    const replacement = audio.src;
    await act(async () => {
      rejectOld(new Error('replaced load'));
    });
    await settle();
    expect(audio.src).toBe(replacement);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.paused).toBe(false);
    expect(AmbientAudioEngine.getInstance().getLoadStatus()).toMatchObject({
      state: 'playing',
      url: replacement,
    });
  });
});
