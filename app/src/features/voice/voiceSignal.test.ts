import { describe, expect, it, vi } from 'vitest';
import {
  computeRms,
  createVoiceSignalController,
  normalizeVoiceLevel,
  smoothVoiceLevel,
} from './voiceSignal';
import { setJarvisPlaybackEnergy } from './jarvisPlaybackEnergy';

function harness() {
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const track = { stop: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 4,
    getByteTimeDomainData: vi.fn((samples: Uint8Array) => {
      samples.set([128, 192, 128, 64]);
    }),
    disconnect: vi.fn(),
  };
  const audioContext = {
    state: 'running',
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    close: vi.fn(async () => undefined),
  };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  const runFrame = (time = 100) => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('No animation frame is pending');
    frames.delete(entry[0]);
    entry[1](time);
  };
  return {
    deps: {
      getUserMedia,
      createAudioContext: () => audioContext,
      requestFrame,
      cancelFrame,
    },
    analyser,
    audioContext,
    getUserMedia,
    runFrame,
    source,
    track,
  };
}

describe('voice signal math', () => {
  it('measures silence, gated noise, and louder samples truthfully', () => {
    expect(computeRms([128, 128, 128, 128])).toBe(0);
    expect(normalizeVoiceLevel(0)).toBe(0);
    expect(normalizeVoiceLevel(0.01)).toBe(0);
    expect(normalizeVoiceLevel(0.12)).toBeGreaterThan(normalizeVoiceLevel(0.04));
  });

  it('attacks faster than it releases', () => {
    const rising = smoothVoiceLevel(0, 1, 0.4, 0.1);
    const falling = smoothVoiceLevel(1, 0, 0.4, 0.1);
    expect(rising).toBeCloseTo(0.4);
    expect(falling).toBeCloseTo(0.9);
  });
});

describe('createVoiceSignalController', () => {
  it('measures microphone waveform energy and releases every audio resource', async () => {
    const test = harness();
    const levelRef = { current: 0 };
    const controller = createVoiceSignalController(levelRef, test.deps);

    await controller.startListening();
    expect(test.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(test.source.connect).toHaveBeenCalledWith(test.analyser);

    test.runFrame();
    expect(levelRef.current).toBeGreaterThan(0);

    controller.stop();
    expect(levelRef.current).toBe(0);
    expect(test.track.stop).toHaveBeenCalledTimes(1);
    expect(test.source.disconnect).toHaveBeenCalledTimes(1);
    expect(test.analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(test.audioContext.close).toHaveBeenCalledTimes(1);
  });

  it('follows real Jarvis playback energy and stays silent without output', () => {
    const test = harness();
    const levelRef = { current: 0 };
    const controller = createVoiceSignalController(levelRef, test.deps);

    controller.startSpeaking();
    expect(levelRef.current).toBe(0);
    expect(test.getUserMedia).not.toHaveBeenCalled();

    setJarvisPlaybackEnergy(0.8);
    expect(levelRef.current).toBeGreaterThan(0.2);
    expect(levelRef.current).toBeLessThanOrEqual(1);

    controller.stop();
    expect(levelRef.current).toBe(0);
  });

  it('silently degrades when microphone access is unavailable', async () => {
    const test = harness();
    test.deps.getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const levelRef = { current: 0.75 };
    const controller = createVoiceSignalController(levelRef, test.deps);

    await expect(controller.startListening()).resolves.toBeUndefined();
    expect(levelRef.current).toBe(0);
  });

  it('releases the microphone if audio graph setup fails', async () => {
    const test = harness();
    test.deps.createAudioContext = () => {
      throw new Error('audio context unavailable');
    };
    const controller = createVoiceSignalController({ current: 0 }, test.deps);

    await expect(controller.startListening()).resolves.toBeUndefined();
    expect(test.track.stop).toHaveBeenCalledTimes(1);
  });

  it('disposes a microphone stream that resolves after the controller stops', async () => {
    const test = harness();
    let resolveStream!: (stream: { getTracks(): Array<typeof test.track> }) => void;
    test.deps.getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
    );
    const controller = createVoiceSignalController({ current: 0 }, test.deps);

    const starting = controller.startListening();
    controller.stop();
    resolveStream({ getTracks: () => [test.track] });
    await starting;

    expect(test.track.stop).toHaveBeenCalledTimes(1);
    expect(test.audioContext.createMediaStreamSource).not.toHaveBeenCalled();
  });
});
