import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetSttVolume,
  setSttVolumeLevel,
  sttVolumeRef,
  startSttVolumeMeter,
  stopSttVolumeMeter,
} from './sttVolume';

describe('sttVolume', () => {
  it('clamps level into 0–1 range', () => {
    setSttVolumeLevel(1.5);
    expect(sttVolumeRef.current).toBe(1);
    setSttVolumeLevel(-0.2);
    expect(sttVolumeRef.current).toBe(0);
    resetSttVolume();
    expect(sttVolumeRef.current).toBe(0);
  });
});

describe('microphone meter ownership', () => {
  afterEach(() => {
    stopSttVolumeMeter();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases capture arriving after cancellation without creating an audio graph', async () => {
    let resolve!: (stream: unknown) => void;
    const stop = vi.fn();
    const construct = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          construct();
          throw new Error('must not construct');
        }
      },
    );
    const starting = startSttVolumeMeter();
    stopSttVolumeMeter();
    resolve({ getTracks: () => [{ stop }] });
    await starting;
    expect(construct).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(sttVolumeRef.current).toBe(0);
  });

  it('releases the acquired microphone if graph initialization throws', async () => {
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('audio setup unavailable');
        }
      },
    );
    await startSttVolumeMeter();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects non-finite energy rather than leaving the waveform invalid', () => {
    setSttVolumeLevel(Number.NaN);
    expect(sttVolumeRef.current).toBe(0);
  });
});
