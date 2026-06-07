import { afterEach, vi } from 'vitest';
import { selectPersonaVoice, speakText, VOICE_PREVIEW_TEXT } from './speechSynthesis';

function voice(name: string, lang = 'en-US', extra: Partial<SpeechSynthesisVoice> = {}): SpeechSynthesisVoice {
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
  afterEach(() => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
    vi.restoreAllMocks();
  });

  it('prefers a high-quality persona-matched voice', () => {
    const selected = selectPersonaVoice([
      voice('Generic English'),
      voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', { localService: false }),
      voice('Spanish Voice', 'es-ES'),
    ], 'jarvis');

    expect(selected?.name).toContain('Ryan');
  });

  it('honors an explicit voice name before persona scoring', () => {
    const selected = selectPersonaVoice([
      voice('Microsoft Ryan Online (Natural)'),
      voice('Samantha'),
    ], 'jarvis', { voiceName: 'Samantha' });

    expect(selected?.name).toBe('Samantha');
  });

  it('uses the selected persona voice and resolves when playback ends', async () => {
    const spoken: MockUtterance[] = [];
    installSpeechMocks({
      voices: [voice('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', { localService: false })],
      onSpeak: (utterance) => {
        spoken.push(utterance);
        queueMicrotask(() => utterance.onend?.({} as SpeechSynthesisEvent));
      },
    });

    await expect(speakText(VOICE_PREVIEW_TEXT, { persona: 'jarvis' })).resolves.toBeUndefined();

    expect(spoken[0]?.text).toBe("Hi, how's your day doing? Jarvis is online.");
    expect((spoken[0]?.voice as SpeechSynthesisVoice | undefined)?.name).toContain('Ryan');
  });

  it('does not fail an older preview when a newer preview supersedes it', async () => {
    const spoken: Array<MockUtterance> = [];
    installSpeechMocks({
      voices: [voice('Samantha')],
      onSpeak: (utterance) => {
        spoken.push(utterance);
      },
    });

    const first = speakText('First preview.', { persona: 'athena' });
    await vi.waitFor(() => expect(spoken).toHaveLength(1));

    const second = speakText('Second preview.', { persona: 'athena' });
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
