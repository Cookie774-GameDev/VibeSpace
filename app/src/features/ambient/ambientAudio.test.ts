import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbientAudioEngine, musicProjectSignature } from './ambientAudio';
import { MUSIC_LIBRARY } from './music-studio/catalog';
import type { MusicClip } from './music-studio/musicProject';

class FakeAudio extends EventTarget {
  src = '';
  currentSrc = '';
  currentTime = 0;
  duration = 90;
  volume = 1;
  playbackRate = 1;
  loop = false;
  paused = true;
  readyState = 1;
  error: MediaError | null = null;
  load = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
  removeAttribute = vi.fn();
}

const clips: MusicClip[] = MUSIC_LIBRARY.slice(0, 2).map((track, index) => ({
  id: `clip-${index}`,
  source: 'cloud',
  trackId: track.id,
  name: track.name,
  trimStart: index + 2,
  trimEnd: index === 0 ? 10 : null,
  speed: index === 0 ? 1.25 : 1,
}));

describe('AmbientAudioEngine music projects', () => {
  afterEach(() => {
    AmbientAudioEngine.getInstance().dispose();
    vi.unstubAllGlobals();
  });

  it('creates a stable signature from order, edits, and loop state', () => {
    expect(musicProjectSignature(clips, true)).not.toBe(
      musicProjectSignature([...clips].reverse(), true),
    );
    expect(musicProjectSignature(clips, true)).not.toBe(musicProjectSignature(clips, false));
  });

  it('plays trims/speed and advances to the next clip without a second engine', async () => {
    const instances: FakeAudio[] = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    await Promise.resolve();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ currentTime: 2, playbackRate: 1.25, volume: 0.4 });
    const firstSrc = instances[0]!.src;
    instances[0]!.currentTime = 10;
    instances[0]!.dispatchEvent(new Event('timeupdate'));
    await Promise.resolve();
    expect(instances[0]!.src).not.toBe(firstSrc);
    expect(instances[0]!.currentTime).toBe(3);
  });

  it('loops from the last clip to the first and stays paused when stopped', async () => {
    const instances: FakeAudio[] = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    await Promise.resolve();
    const audio = instances[0]!;
    const firstSrc = audio.src;
    audio.currentTime = clips[0]!.trimEnd!;
    audio.dispatchEvent(new Event('timeupdate'));
    await Promise.resolve();
    expect(audio.src).not.toBe(firstSrc);
    audio.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    expect(audio.src).toBe(firstSrc);
    expect(audio.currentTime).toBe(clips[0]!.trimStart);
    engine.stop();
    expect(audio.paused).toBe(true);
  });

  it('keeps a track failure visible instead of reporting playback success', async () => {
    const instances: FakeAudio[] = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    await Promise.resolve();
    instances[0]!.error = { code: 4, message: 'Unsupported media' } as MediaError;
    instances[0]!.dispatchEvent(new Event('error'));
    expect(engine.getLoadStatus()).toMatchObject({ state: 'error' });
    expect(engine.isPlaying()).toBe(false);
  });

  it('publishes current song progress and seeks within its playable timeline', async () => {
    const instances: FakeAudio[] = [];
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    const progress = vi.fn();
    const unsubscribe = engine.subscribeProgress(progress);

    engine.playProject([clips[0]!], false, 55);
    await Promise.resolve();
    expect(progress).toHaveBeenLastCalledWith({
      clipId: clips[0]!.id,
      currentTime: 2,
      duration: 90,
    });

    expect(engine.seek(7.5)).toBe(true);
    expect(instances[0]!.currentTime).toBe(7.5);
    expect(progress).toHaveBeenLastCalledWith({
      clipId: clips[0]!.id,
      currentTime: 7.5,
      duration: 90,
    });
    expect(engine.seek(-5)).toBe(true);
    expect(instances[0]!.currentTime).toBe(2);
    expect(engine.seek(99)).toBe(true);
    expect(instances[0]!.currentTime).toBe(10);
    unsubscribe();
  });
});
