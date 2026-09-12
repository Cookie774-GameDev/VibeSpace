import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureMicrophoneSample,
  classifyMicrophoneLevels,
  microphoneCaptureErrorKind,
} from './microphoneTest';

describe('microphone test analysis', () => {
  it('fails a silent capture', () => {
    expect(classifyMicrophoneLevels([0, 0.004, 0.008])).toMatchObject({
      verdict: 'silent',
      passed: false,
    });
  });

  it('fails sustained loud background noise', () => {
    expect(classifyMicrophoneLevels([0.55, 0.57, 0.56, 0.58])).toMatchObject({
      verdict: 'noisy',
      passed: false,
    });
  });

  it('passes a voice-shaped capture', () => {
    expect(classifyMicrophoneLevels([0.01, 0.04, 0.12, 0.31, 0.08, 0.02])).toMatchObject({
      verdict: 'pass',
      passed: true,
    });
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'no_device'],
    ['NotReadableError', 'unavailable'],
  ] as const)('maps %s without exposing exception content', (name, expected) => {
    expect(microphoneCaptureErrorKind(new DOMException('private device detail', name))).toBe(
      expected,
    );
  });
});

describe('captureMicrophoneSample', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('captures the selected device locally and releases every audio resource', async () => {
    vi.useFakeTimers();

    const stopTrack = vi.fn();
    const disconnectSource = vi.fn();
    const closeContext = vi.fn().mockResolvedValue(undefined);
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });

    class FakeAudioContext {
      state = 'running';
      createAnalyser() {
        return {
          fftSize: 512,
          smoothingTimeConstant: 0,
          getByteTimeDomainData: (samples: Uint8Array) => samples.fill(145),
        };
      }
      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: disconnectSource,
        };
      }
      close = closeContext;
    }

    class FakeMediaRecorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      private readonly listeners: Array<() => void> = [];
      constructor(_stream: MediaStream) {}
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['voice']) });
        this.listeners.forEach((listener) => listener());
      }
      addEventListener(_type: string, listener: () => void) {
        this.listeners.push(listener);
      }
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const onLevel = vi.fn();
    const capture = captureMicrophoneSample({
      deviceId: 'studio-mic',
      durationMs: 1_000,
      onLevel,
    });

    await vi.advanceTimersByTimeAsync(1_100);
    const result = await capture;

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'studio-mic' } },
    });
    expect(result.verdict).toBe('pass');
    expect(result.recording?.size).toBeGreaterThan(0);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });
});
