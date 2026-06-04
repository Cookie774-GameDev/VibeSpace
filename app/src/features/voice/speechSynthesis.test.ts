import { selectPersonaVoice } from './speechSynthesis';

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
});
