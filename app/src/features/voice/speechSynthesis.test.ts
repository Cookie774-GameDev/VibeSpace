import { afterEach, beforeEach, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import {
  selectPersonaVoice,
  selectVoiceProfileVoice,
  speakText,
  stopSpeech,
  SPEECH_SYNTHESIS_END_EVENT,
  SPEECH_SYNTHESIS_START_EVENT,
  VOICE_PREVIEW_TEXT,
} from './speechSynthesis';

function voice(
  name: string,
  lang = 'en-US',
  extra: Partial<SpeechSynthesisVoice> = {},
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    voiceURI: name,
    default: false,
    localService: true,
    ...extra,
  };
}

describe('speech synthesis voice selection', () => {
  beforeEach(() => {
    useAuthStore.setState({
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
    vi.restoreAllMocks();
  });

  it('prefers a high-quality persona-matched voice', () => {
    const selected = selectPersonaVoice(
      [
        voice('Generic English'),
        voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', {
          localService: false,
        }),
        voice('Spanish Voice', 'es-ES'),
      ],
      'jarvis',
    );

    expect(selected?.name).toContain('Ryan');
  });

  it('honors an explicit voice name before persona scoring', () => {
    const selected = selectPersonaVoice(
      [voice('Microsoft Ryan Online (Natural)'), voice('Samantha')],
      'jarvis',
      { voiceName: 'Samantha' },
    );

    expect(selected?.name).toBe('Samantha');
  });

  it('selects the best voice for a persisted voice profile', () => {
    const selected = selectVoiceProfileVoice(
      [
        voice('Samantha'),
        voice('Microsoft Guy Online (Natural)', 'en-US', { localService: false }),
        voice('Generic English'),
      ],
      'atlas',
    );

    expect(selected?.name).toContain('Guy');
  });

  it('filters out online voices in local-only mode', () => {
    const selected = selectVoiceProfileVoice(
      [
        voice('Microsoft Ryan Online (Natural)', 'en-GB', { localService: false }),
        voice('David Desktop', 'en-US', { localService: true }),
      ],
      'jarvis-prime',
      { engine: 'local' },
    );

    expect(selected?.name).toBe('David Desktop');
  });

  it('uses the selected persona voice and resolves when playback ends', async () => {
    const spoken: MockUtterance[] = [];
    installSpeechMocks({
      voices: [
        voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', {
          localService: false,
        }),
      ],
      onSpeak: (utterance) => {
        spoken.push(utterance);
        queueMicrotask(() => utterance.onend?.({} as SpeechSynthesisEvent));
      },
    });

    await expect(speakText(VOICE_PREVIEW_TEXT, { persona: 'jarvis' })).resolves.toBeUndefined();

    expect(spoken[0]?.text).toBe('Hi, what should we get to work on?');
    expect((spoken[0]?.voice as SpeechSynthesisVoice | undefined)?.name).toContain('Ryan');
  });

  it('emits lifecycle events around spoken replies', async () => {
    const events: string[] = [];
    window.addEventListener(SPEECH_SYNTHESIS_START_EVENT, () => events.push('start'));
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, () => events.push('end'));
    installSpeechMocks({
      voices: [
        voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', {
          localService: false,
        }),
      ],
      onSpeak: (utterance) => {
        queueMicrotask(() => utterance.onend?.({} as SpeechSynthesisEvent));
      },
    });

    await speakText('Status report ready.', { persona: 'jarvis' });

    expect(events).toEqual(['start', 'end']);
  });

  it('uses persisted voice profile tuning for normal speech', async () => {
    useAuthStore.setState({
      voicePreset: 'atlas',
      voiceEngine: 'system',
    });
    const spoken: MockUtterance[] = [];
    installSpeechMocks({
      voices: [voice('Microsoft Guy Online (Natural)', 'en-US', { localService: false })],
      onSpeak: (utterance) => {
        spoken.push(utterance);
        queueMicrotask(() => utterance.onend?.({} as SpeechSynthesisEvent));
      },
    });

    await speakText('Status report ready.');

    expect((spoken[0]?.voice as SpeechSynthesisVoice | undefined)?.name).toContain('Guy');
    expect(spoken[0]?.rate).toBe(1.12);
    expect(spoken[0]?.pitch).toBe(0.66);
  });

  it('fails clearly when local mode has no installed voice', async () => {
    installSpeechMocks({
      voices: [voice('Microsoft Ryan Online (Natural)', 'en-GB', { localService: false })],
      onSpeak: vi.fn(),
    });

    await expect(speakText('Status report ready.', { engine: 'local' })).rejects.toThrow(
      'No installed local system voice was found',
    );
  });

  it('does not fail an older preview when a newer preview supersedes it', async () => {
    const spoken: Array<MockUtterance> = [];
    installSpeechMocks({
      voices: [voice('Samantha')],
      onSpeak: (utterance) => {
        spoken.push(utterance);
      },
    });

    const first = speakText('First preview.', { persona: 'friday' });
    await vi.waitFor(() => expect(spoken).toHaveLength(1));

    const second = speakText('Second preview.', { persona: 'friday' });
    await vi.waitFor(() => expect(spoken).toHaveLength(2));

    spoken[0]?.onerror?.({ error: 'interrupted' } as SpeechSynthesisErrorEvent);
    spoken[1]?.onend?.({} as SpeechSynthesisEvent);

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });
});

interface InstallSpeechMocksOptions {
  voices: SpeechSynthesisVoice[];
  onSpeak: (utterance: MockUtterance) => void;
}

class MockUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechMocks({ voices, onSpeak }: InstallSpeechMocksOptions) {
  const synthesis = {
    speaking: false,
    pending: false,
    onvoiceschanged: null as SpeechSynthesis['onvoiceschanged'],
    getVoices: vi.fn(() => voices),
    cancel: vi.fn(),
    resume: vi.fn(),
    speak: vi.fn((utterance: MockUtterance) => {
      synthesis.speaking = true;
      onSpeak(utterance);
    }),
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: synthesis,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    value: MockUtterance,
    configurable: true,
  });
  return synthesis;
}

describe('speech completion watchdog ownership', () => {
  let spoken: MockUtterance[];
  let synthesis: ReturnType<typeof installSpeechMocks>;
  beforeEach(() => {
    stopSpeech();
    vi.useFakeTimers();
    useAuthStore.setState({ voicePreset: 'jarvis-prime', voiceEngine: 'system' });
    spoken = [];
    synthesis = installSpeechMocks({
      voices: [voice('David')],
      onSpeak: (utterance) => spoken.push(utterance),
    });
  });
  afterEach(() => {
    stopSpeech();
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'speechSynthesis');
    Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
    vi.restoreAllMocks();
  });
  async function begin(text = 'A synthetic reply.') {
    const promise = speakText(text, { engine: 'system' });
    await vi.advanceTimersByTimeAsync(0);
    expect(spoken.length).toBeGreaterThan(0);
    return { promise };
  }
  const longText = 'This synthetic speech continues naturally beyond the heuristic budget. '.repeat(
    30,
  );

  it('waits for the real end of healthy speech beyond20 seconds without cancelling it', async () => {
    const { promise } = await begin(longText);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(21000);
    const prematurelySettled = settled;
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    spoken[0].onend?.({} as SpeechSynthesisEvent);
    await promise;
    expect(prematurelySettled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a queued pending utterance beyond the heuristic until its real end', async () => {
    const { promise } = await begin(longText);
    synthesis.speaking = false;
    synthesis.pending = true;
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(24000);
    const prematurelySettled = settled;
    spoken[0].onend?.({} as SpeechSynthesisEvent);
    await promise;
    expect(prematurelySettled).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects inactive missing completion with a fixed typed error and no extra cancellation', async () => {
    const { promise } = await begin();
    const expectedFailure = {
      name: 'SpeechSynthesisCompletionError',
      code: 'completion_unobserved',
    };
    const outcome = promise.then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    synthesis.speaking = false;
    await vi.advanceTimersByTimeAsync(1800);
    expect(await outcome).toMatchObject({ status: 'rejected', error: expectedFailure });
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks an active long utterance after the deadline and fails truthfully once inactive without end', async () => {
    const { promise } = await begin(longText);
    const expectedFailure = { code: 'completion_unobserved' };
    const outcome = promise.then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    await vi.advanceTimersByTimeAsync(21000);
    synthesis.speaking = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await outcome).toMatchObject({ status: 'rejected', error: expectedFailure });
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats an actual end as authoritative even while the global engine activity flag lags', async () => {
    const { promise } = await begin();
    await vi.advanceTimersByTimeAsync(500);
    expect(synthesis.speaking).toBe(true);
    spoken[0].onend?.({} as SpeechSynthesisEvent);
    await expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(24000);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a silently cancelled retired owner without treating its stale active flag as current', async () => {
    const { promise } = await begin(longText);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(21000);
    const prematurelySettled = settled;
    stopSpeech();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBeUndefined();
    expect(prematurelySettled).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not cancel a replacement synchronously admitted by an end-event listener', async () => {
    const { promise } = await begin();
    const outcome = promise.then(
      () => ({ status: 'resolved' }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    synthesis.speaking = false;
    let replacement: Promise<void> | undefined;
    const replace = () => {
      replacement = speakText('Fresh replacement.', { engine: 'system' });
    };
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, replace, { once: true });
    await vi.advanceTimersByTimeAsync(1800);
    expect(await outcome).toMatchObject({ status: 'resolved' });
    await vi.advanceTimersByTimeAsync(1);
    expect(spoken).toHaveLength(2);
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    spoken[1].onend?.({} as SpeechSynthesisEvent);
    await replacement;
    await vi.advanceTimersByTimeAsync(2000);
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late end and error callbacks after an inactive completion failure', async () => {
    let ends = 0;
    const count = () => {
      ends += 1;
    };
    window.addEventListener(SPEECH_SYNTHESIS_END_EVENT, count);
    try {
      const { promise } = await begin();
      const expectedFailure = { code: 'completion_unobserved' };
      const outcome = promise.then(
        () => ({ status: 'resolved' }),
        (error: unknown) => ({ status: 'rejected', error }),
      );
      synthesis.speaking = false;
      await vi.advanceTimersByTimeAsync(1800);
      expect(await outcome).toMatchObject({ status: 'rejected', error: expectedFailure });
      spoken[0].onend?.({} as SpeechSynthesisEvent);
      spoken[0].onerror?.({ error: 'synthesis-failed' } as SpeechSynthesisErrorEvent);
      expect(ends).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      window.removeEventListener(SPEECH_SYNTHESIS_END_EVENT, count);
    }
  });
  it('clears the owned early resume timer when a real end arrives immediately', async () => {
    const { promise } = await begin();
    spoken[0].onend?.({} as SpeechSynthesisEvent);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });
});
