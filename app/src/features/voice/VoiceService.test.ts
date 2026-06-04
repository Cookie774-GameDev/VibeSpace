import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceService,
  VOICE_EXCLUSIVE_START_EVENT,
  VOICE_EXCLUSIVE_STOP_EVENT,
} from './VoiceService';

let lastRecognition: MockRecognition | null = null;

class MockRecognition {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  maxAlternatives = 1;
  onresult = null;
  onerror = null;
  onstart: ((event: Event) => void) | null = null;
  onend: ((event: Event) => void) | null = null;
  onnomatch = null;

  constructor() {
    lastRecognition = this;
  }

  start = vi.fn(() => {
    this.onstart?.(new Event('start'));
  });

  stop = vi.fn(() => {
    this.onend?.(new Event('end'));
  });

  abort = vi.fn(() => {
    this.onend?.(new Event('end'));
  });
}

describe('VoiceService exclusive mic lifecycle', () => {
  afterEach(() => {
    VoiceService.abort();
    Reflect.deleteProperty(window, 'SpeechRecognition');
    Reflect.deleteProperty(window, 'webkitSpeechRecognition');
    vi.restoreAllMocks();
    lastRecognition = null;
  });

  it('announces exclusive mic ownership while recognition is active', () => {
    Object.defineProperty(window, 'SpeechRecognition', {
      value: MockRecognition,
      configurable: true,
    });
    const starts: Event[] = [];
    const stops: Event[] = [];
    const onStart = (event: Event) => starts.push(event);
    const onStop = (event: Event) => stops.push(event);
    window.addEventListener(VOICE_EXCLUSIVE_START_EVENT, onStart);
    window.addEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onStop);

    try {
      expect(VoiceService.startListening()).toBe(true);
      expect(lastRecognition?.start).toHaveBeenCalledTimes(1);
      expect(starts).toHaveLength(1);

      VoiceService.stopListening();

      expect(lastRecognition?.stop).toHaveBeenCalledTimes(1);
      expect(stops).toHaveLength(1);
    } finally {
      window.removeEventListener(VOICE_EXCLUSIVE_START_EVENT, onStart);
      window.removeEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onStop);
    }
  });
});
