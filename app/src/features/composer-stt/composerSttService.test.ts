import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { resetSttFocusMemoryForTests, resolveComposerSttTextarea } from './insertText';
import {
  COMPOSER_STT_STOP_EVENT,
  COMPOSER_STT_TOGGLE_EVENT,
  requestComposerSttFromToolbar,
  requestComposerSttToggle,
  startBatchAudioRecorder,
} from './composerSttService';

describe('composerSttService toolbar routing', () => {
  beforeEach(() => {
    useUIStore.setState({ route: 'terminal', composerStt: true, composerSttListening: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSttFocusMemoryForTests();
  });

  it('starts in the active chat pane before any field has been focused', () => {
    useUIStore.setState({ route: 'chat' });
    const workspace = document.createElement('div');
    workspace.innerHTML = '<section data-chat-id="a" data-focused="false"><div data-tour="chat-composer"><textarea aria-label="Message"></textarea></div></section><section data-chat-id="b" data-focused="true"><div data-tour="chat-composer"><textarea aria-label="Message"></textarea></div></section>';
    document.body.append(workspace);
    try {
      resetSttFocusMemoryForTests();
      expect(requestComposerSttFromToolbar()).toBe(true);
      expect(resolveComposerSttTextarea()).toBe(workspace.querySelector('[data-chat-id="b"] textarea'));
    } finally {
      workspace.remove();
    }
  });

  it('does not change route when toolbar mic is pressed', () => {
    const toggle = vi.fn();
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, toggle);
    expect(requestComposerSttFromToolbar()).toBe(true);
    expect(useUIStore.getState().route).toBe('terminal');
    expect(toggle).toHaveBeenCalledTimes(1);
    window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, toggle);
  });

  it('dispatches stop instead of toggle when already listening', () => {
    useUIStore.setState({ composerSttListening: true });
    const stop = vi.fn();
    const toggle = vi.fn();
    window.addEventListener(COMPOSER_STT_STOP_EVENT, stop);
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, toggle);
    expect(requestComposerSttFromToolbar()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
    window.removeEventListener(COMPOSER_STT_STOP_EVENT, stop);
    window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, toggle);
  });

  it('requestComposerSttToggle includes source detail', () => {
    const received: CustomEvent<{ source?: string }>[] = [];
    const handler = (event: Event) => {
      event.preventDefault();
      received.push(event as CustomEvent<{ source?: string }>);
    };
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, handler);
    requestComposerSttToggle('toolbar');
    expect(received[0]?.detail?.source).toBe('toolbar');
    expect(received[0]?.defaultPrevented).toBe(true);
    window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, handler);
  });
});

describe('batch microphone resource lifetime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('releases the microphone if creating its audio context fails', async () => {
    const stopTrack = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('audio context unavailable');
        }
      },
    );
    await expect(startBatchAudioRecorder(vi.fn(), vi.fn())).rejects.toThrow(
      'audio context unavailable',
    );
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('measures microphone samples without retaining raw audio in meter-only mode', async () => {
    const processor = {
      onaudioprocess: null as ((event: unknown) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = 16000;
        destination = {};
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        createScriptProcessor() {
          return processor;
        }
        close = async () => undefined;
      },
    );
    const onLevel = vi.fn();
    const recorder = await startBatchAudioRecorder(onLevel, vi.fn(), { retainAudio: false });
    try {
      processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array([0.0625, -0.0625]) },
      });
      expect(onLevel).toHaveBeenLastCalledWith(0.5);
      expect(recorder.captureWav()).toBeNull();
      processor.onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array([0, 0]) },
      });
      expect(onLevel).toHaveBeenLastCalledWith(0);
    } finally {
      recorder.stop();
    }
  });

  it('clears captured PCM and ignores queued processing callbacks after stop', async () => {
    const stopTrack = vi.fn();
    const processor = {
      onaudioprocess: null as ((event: unknown) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const close = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = 16000;
        destination = {};
        createMediaStreamSource() {
          return source;
        }
        createScriptProcessor() {
          return processor;
        }
        close = close;
      },
    );
    const onLevel = vi.fn();
    const recorder = await startBatchAudioRecorder(onLevel, vi.fn());
    const callback = processor.onaudioprocess!;
    callback({ inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25]) } });
    expect(recorder.captureWav()?.size).toBe(48);
    recorder.stop();
    recorder.stop();
    const updatesAtStop = onLevel.mock.calls.length;
    callback({ inputBuffer: { getChannelData: () => new Float32Array([1, -1]) } });
    expect(recorder.captureWav()).toBeNull();
    expect(processor.onaudioprocess).toBeNull();
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(onLevel).toHaveBeenCalledTimes(updatesAtStop);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
