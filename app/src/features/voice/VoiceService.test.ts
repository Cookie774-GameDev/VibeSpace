import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceService,
  VOICE_EXCLUSIVE_START_EVENT,
  VOICE_EXCLUSIVE_STOP_EVENT,
} from './VoiceService';

let lastRecognition: MockRecognition | null = null;

type MockRecognitionErrorEvent = Event & {
  readonly error: string;
  readonly message?: string;
};

class MockRecognition {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  maxAlternatives = 1;
  onresult = null;
  onerror: ((event: MockRecognitionErrorEvent) => void) | null = null;
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
  it('publishes completed phrases before the next partial in a mixed recognition result', () => {
    Object.defineProperty(window, 'SpeechRecognition', {
      value: MockRecognition,
      configurable: true,
    });
    const order: string[] = [];
    const offFinal = VoiceService.on('voice:final', ({ text }) => order.push(`final:${text}`));
    const offPartial = VoiceService.on('voice:partial', ({ text }) =>
      order.push(`partial:${text}`),
    );
    try {
      VoiceService.startListening();
      const onresult = lastRecognition!.onresult as unknown as (event: unknown) => void;
      onresult({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: 'first phrase' } },
          { isFinal: false, 0: { transcript: 'next thought' } },
        ],
      });
      expect(order).toEqual(['final:first phrase', 'partial:next thought']);
    } finally {
      offFinal();
      offPartial();
    }
  });

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

  it('can synchronously interrupt the active recognition session for a new mic owner', () => {
    Object.defineProperty(window, 'SpeechRecognition', {
      value: MockRecognition,
      configurable: true,
    });
    const ends = vi.fn();
    const stops: Event[] = [];
    const offEnd = VoiceService.on('voice:end', ends);
    const onStop = (event: Event) => stops.push(event);
    window.addEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onStop);

    try {
      expect(VoiceService.startListening()).toBe(true);
      const activeRecognition = lastRecognition;

      VoiceService.interruptListening();

      expect(activeRecognition?.abort).toHaveBeenCalledTimes(1);
      expect(VoiceService.isListening()).toBe(false);
      expect(VoiceService.wantsListening()).toBe(false);
      expect(ends).toHaveBeenCalledTimes(1);
      expect(stops).toHaveLength(1);
    } finally {
      offEnd();
      window.removeEventListener(VOICE_EXCLUSIVE_STOP_EVENT, onStop);
    }
  });

  it('uses precise shared narration when browser speech recognition is unavailable', () => {
    const errors = vi.fn();
    const offError = VoiceService.on('voice:error', errors);

    try {
      expect(VoiceService.startListening()).toBe(false);
      expect(errors).toHaveBeenCalledWith({
        kind: 'unsupported',
        message:
          'The action failed, sir. Action: Speech recognition availability. Cause: Built-in speech recognition is not available in this runtime.',
      });
      expect(VoiceService.isListening()).toBe(false);
      expect(VoiceService.wantsListening()).toBe(false);
    } finally {
      offError();
    }
  });

  it.each([
    {
      browserError: 'not-allowed',
      expectedKind: 'permission_denied',
      expectedMessage:
        'The action failed, sir. Action: Microphone permission. Cause: Microphone permission was denied. Allow access in the browser or operating-system settings, then try again.',
      expectedWantsListening: false,
    },
    {
      browserError: 'service-not-allowed',
      expectedKind: 'service_not_allowed',
      expectedMessage:
        'The action failed, sir. Action: Speech recognition access. Cause: The browser or runtime blocked its speech-recognition service. Enable that service, then try again.',
      expectedWantsListening: false,
    },
    {
      browserError: 'no-speech',
      expectedKind: 'no_speech',
      expectedMessage:
        'The action failed, sir. Action: Speech recognition. Cause: No speech was detected before the recognition session ended.',
      expectedWantsListening: true,
    },
    {
      browserError: 'aborted',
      expectedKind: 'aborted',
      expectedMessage:
        'The action failed, sir. Action: Speech recognition. Cause: Recognition was interrupted before a transcript was captured.',
      expectedWantsListening: true,
    },
    {
      browserError: 'audio-capture',
      expectedKind: 'audio_capture',
      expectedMessage:
        'The action failed, sir. Action: Microphone capture. Cause: No working microphone input was available. Check the selected device and input settings.',
      expectedWantsListening: false,
    },
    {
      browserError: 'network',
      expectedKind: 'network',
      expectedMessage:
        'The action failed, sir. Action: Speech recognition network. Cause: The recognition service could not be reached. Check the network connection, then try again.',
      expectedWantsListening: true,
    },
    {
      browserError: 'synthetic-unknown-code',
      expectedKind: 'unknown',
      expectedMessage:
        'The action failed, sir. Action: Speech recognition. Cause: The browser reported an unrecognized speech-recognition failure.',
      expectedWantsListening: true,
    },
  ])(
    'maps $browserError to safe actionable narration without changing restart intent',
    ({ browserError, expectedKind, expectedMessage, expectedWantsListening }) => {
      Object.defineProperty(window, 'SpeechRecognition', {
        value: MockRecognition,
        configurable: true,
      });
      const errors = vi.fn();
      const offError = VoiceService.on('voice:error', errors);

      try {
        expect(VoiceService.startListening()).toBe(true);
        lastRecognition?.onerror?.(
          Object.assign(new Event('error'), {
            error: browserError,
            message: 'synthetic browser implementation detail',
          }),
        );

        expect(errors).toHaveBeenCalledWith({
          kind: expectedKind,
          message: expectedMessage,
        });
        expect(errors.mock.calls[0]?.[0].message).not.toContain(
          'synthetic browser implementation detail',
        );
        expect(VoiceService.wantsListening()).toBe(expectedWantsListening);
      } finally {
        offError();
      }
    },
  );

  it('uses safe startup narration and releases exclusive mic ownership when recognition start throws', () => {
    class ThrowingRecognition extends MockRecognition {
      constructor() {
        super();
        this.start.mockImplementation(() => {
          throw new Error('synthetic recognition startup detail');
        });
      }
    }
    Object.defineProperty(window, 'SpeechRecognition', {
      value: ThrowingRecognition,
      configurable: true,
    });
    const errors = vi.fn();
    const stops = vi.fn();
    const offError = VoiceService.on('voice:error', errors);
    window.addEventListener(VOICE_EXCLUSIVE_STOP_EVENT, stops);

    try {
      expect(VoiceService.startListening()).toBe(false);
      expect(errors).toHaveBeenCalledWith({
        kind: 'unknown',
        message:
          'The action failed, sir. Action: Speech recognition startup. Cause: The browser could not start recognition. Stop other microphone sessions, then try again.',
      });
      expect(errors.mock.calls[0]?.[0].message).not.toContain(
        'synthetic recognition startup detail',
      );
      expect(VoiceService.isListening()).toBe(false);
      expect(VoiceService.wantsListening()).toBe(false);
      expect(stops).toHaveBeenCalledOnce();
    } finally {
      offError();
      window.removeEventListener(VOICE_EXCLUSIVE_STOP_EVENT, stops);
    }
  });
});
