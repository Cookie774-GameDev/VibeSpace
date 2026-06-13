import { describe, expect, it } from 'vitest';
import { deepgramListenUrl } from './deepgramDictation';

describe('deepgramListenUrl', () => {
  it('requests realtime smart-formatted dictation with interim results', () => {
    const url = new URL(deepgramListenUrl());

    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('interim_results')).toBe('true');
  });
});
