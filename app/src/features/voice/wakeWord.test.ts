import { containsWakePhrase, normalizeWakeTranscript } from './wakeWord';

describe('wake word helpers', () => {
  it('normalizes punctuation and spacing', () => {
    expect(normalizeWakeTranscript('  Hey,   Jarvis!  ')).toBe('hey jarvis');
  });

  it('accepts direct and natural wake phrases', () => {
    expect(containsWakePhrase('Jarvis')).toBe(true);
    expect(containsWakePhrase('hey jarvis open voice')).toBe(true);
    expect(containsWakePhrase('hello Jarvis')).toBe(true);
    expect(containsWakePhrase('yo jarvis')).toBe(true);
    expect(containsWakePhrase('okay, Jarvis')).toBe(true);
    expect(containsWakePhrase('wake up jarvis')).toBe(true);
  });

  it('does not match words that only contain jarvis as a substring', () => {
    expect(containsWakePhrase('jarvisian')).toBe(false);
    expect(containsWakePhrase('the jarvisone build')).toBe(false);
  });
});
