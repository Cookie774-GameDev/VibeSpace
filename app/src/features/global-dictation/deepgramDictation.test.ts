import { describe, expect, it } from 'vitest';
import { deepgramListenUrl, parseDeepgramMessage } from './deepgramDictation';

describe('deepgramListenUrl', () => {
  it('requests realtime smart-formatted dictation with interim results', () => {
    const url = new URL(deepgramListenUrl('nova-3-mono'));

    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('interim_results')).toBe('true');
  });

  it('routes Flux presets through the required v2 endpoint', () => {
    const url = new URL(deepgramListenUrl('flux-en'));
    expect(url.pathname).toBe('/v2/listen');
    expect(url.searchParams.get('model')).toBe('flux-general-en');
    expect(url.searchParams.has('smart_format')).toBe(false);
  });

  it('normalizes Nova interim/final and Flux turn messages into one dictation contract', () => {
    expect(
      parseDeepgramMessage({
        channel: { alternatives: [{ transcript: 'working' }] },
        is_final: false,
      }),
    ).toEqual({ kind: 'partial', transcript: 'working' });
    expect(
      parseDeepgramMessage({
        channel: { alternatives: [{ transcript: 'done' }] },
        speech_final: true,
      }),
    ).toEqual({ kind: 'final', transcript: 'done' });
    expect(
      parseDeepgramMessage({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        transcript: 'flux done',
      }),
    ).toEqual({ kind: 'final', transcript: 'flux done' });
    expect(
      parseDeepgramMessage({
        type: 'TurnInfo',
        event: 'Update',
        transcript: 'flux working',
      }),
    ).toEqual({ kind: 'partial', transcript: 'flux working' });
  });
});
