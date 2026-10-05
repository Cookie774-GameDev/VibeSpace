import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicClip } from './music-studio/musicProject';

const mocks = vi.hoisted(() => {
  const clips: MusicClip[] = [
    {
      id: 'first',
      source: 'cloud',
      trackId: 'first-track',
      name: 'First',
      trimStart: 3,
      trimEnd: 12,
      speed: 1.25,
    },
    {
      id: 'second',
      source: 'cloud',
      trackId: 'second-track',
      name: 'Second',
      trimStart: 0,
      trimEnd: null,
      speed: 1,
    },
  ];
  return {
    audio: {
      play: vi.fn(),
      playProject: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
    },
    clips,
    project: { clips, enabledForAmbient: true, loop: false },
    ui: {
      ambient: false,
      ambientActive: false,
      ambientAlwaysPlay: true,
      ambientDrone: false,
      ambientTrack: 'music-1',
      ambientVolume: 42,
    },
  };
});

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign((selector: (state: typeof mocks.ui) => unknown) => selector(mocks.ui), {
    getState: () => mocks.ui,
  }),
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: { plan: string }) => unknown) => selector({ plan: 'free' }),
}));
vi.mock('@/lib/admin', () => ({ useAppAdmin: () => false }));
vi.mock('@/lib/entitlements', () => ({ effectivePlan: (plan: string) => plan }));
vi.mock('./tracks', () => ({ getPlayableAmbientTrack: () => 'music-1' }));
vi.mock('./ambientAudio', () => ({
  AmbientAudioEngine: { getInstance: () => mocks.audio },
}));
vi.mock('./music-studio/musicProject', () => ({
  useMusicProjectStore: (selector: (state: typeof mocks.project) => unknown) =>
    selector(mocks.project),
}));

import { AmbientAudioHost } from './AmbientAudioHost';

describe('AmbientAudioHost saved mix source', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('routes the selected saved order, loop setting, and current volume during 24/7 playback', () => {
    render(<AmbientAudioHost />);

    expect(mocks.audio.playProject).toHaveBeenCalledWith(mocks.clips, false, 42);
    expect(mocks.audio.play).not.toHaveBeenCalled();
  });
});
