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

  it('jumps between mix clips and resumes the paused clip without resetting its position', async () => {
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
    engine.playProjectAt(clips, true, 45, 1);
    await Promise.resolve();
    const audio = instances[0]!;
    expect(audio.src).toContain(clips[1]!.trackId);
    expect(audio.currentTime).toBe(clips[1]!.trimStart);
    audio.currentTime = 18;
    engine.pause();
    expect(audio.paused).toBe(true);
    engine.playProject(clips, true, 45);
    await Promise.resolve();
    expect(audio.src).toContain(clips[1]!.trackId);
    expect(audio.currentTime).toBe(18);
    engine.playProjectAt(clips, true, 45, 0);
    await Promise.resolve();
    expect(audio.src).toContain(clips[0]!.trackId);
    expect(audio.currentTime).toBe(clips[0]!.trimStart);
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

  it.each([
    ['pause', 'timeupdate'],
    ['pause', 'ended'],
    ['stop', 'timeupdate'],
    ['stop', 'ended'],
  ] as const)(
    'keeps the paused clip selected after %s then a late %s event',
    async (action, event) => {
      const audio = new FakeAudio();
      vi.stubGlobal(
        'Audio',
        class {
          constructor() {
            return audio;
          }
        },
      );
      const engine = AmbientAudioEngine.getInstance();
      engine.playProject(clips, true, 40);
      await Promise.resolve();
      engine[action]();
      audio.currentTime = clips[0]!.trimEnd!;
      audio.dispatchEvent(new Event(event));
      const afterTimeUpdate = vi.fn();
      const unsubscribe = engine.subscribeProgress(afterTimeUpdate);
      expect(afterTimeUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ clipId: clips[0]!.id }),
      );
      expect(engine.seek(0)).toBe(true);
      expect(audio.currentTime).toBe(clips[0]!.trimStart);
      expect(afterTimeUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ clipId: clips[0]!.id }),
      );
      expect(audio.play).toHaveBeenCalledTimes(1);
      expect(audio.paused).toBe(true);
      unsubscribe();
    },
  );

  it('does not seek a replacement ambient track with an old mix metadata callback', () => {
    const audio = new FakeAudio();
    audio.readyState = 0;
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    engine.play('music-2', 40);
    audio.currentTime = 0;
    audio.readyState = 1;
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(0);
    expect(audio.playbackRate).toBe(1);
    expect(audio.loop).toBe(true);
  });

  it('detaches pending metadata work when the media handle is disposed', () => {
    const audio = new FakeAudio();
    audio.readyState = 0;
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    engine.dispose();
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(0);
  });

  it('still applies a pending trim when the same clip receives metadata while paused', () => {
    const audio = new FakeAudio();
    audio.readyState = 0;
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, true, 40);
    engine.pause();
    audio.readyState = 1;
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(audio.currentTime).toBe(clips[0]!.trimStart);
    expect(audio.paused).toBe(true);
  });

  it('plays a non-looping mix once and ignores further end events until requested again', async () => {
    const audio = new FakeAudio();
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject(clips, false, 40);
    await Promise.resolve();
    audio.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalledTimes(2);
    audio.dispatchEvent(new Event('ended'));
    expect(engine.isPlaying()).toBe(false);
    audio.dispatchEvent(new Event('ended'));
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.paused).toBe(true);
  });

  it('applies only the replacement clip trim when metadata arrives after a mix switch', () => {
    const audio = new FakeAudio();
    audio.readyState = 0;
    vi.stubGlobal(
      'Audio',
      class {
        constructor() {
          return audio;
        }
      },
    );
    const engine = AmbientAudioEngine.getInstance();
    engine.playProject([clips[0]!], false, 40);
    engine.playProject([clips[1]!], false, 40);
    const progress = vi.fn();
    const unsubscribe = engine.subscribeProgress(progress);
    progress.mockClear();
    audio.readyState = 1;
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith({
      clipId: clips[1]!.id,
      currentTime: clips[1]!.trimStart,
      duration: 90,
    });
    unsubscribe();
  });
});
