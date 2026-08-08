import { describe, expect, it } from 'vitest';
import {
  DEEPGRAM_STT_OPTIONS,
  calculateDeepgramCost,
  deepgramHoursForBudget,
  deepgramListenUrl,
  getDeepgramPriceFreshness,
  isDeepgramPriceStale,
} from './catalog';

describe('Deepgram STT catalog', () => {
  it('offers five verified streaming choices without inventing runtime identifiers', () => {
    expect(DEEPGRAM_STT_OPTIONS.map((option) => option.runtimeModel)).toEqual([
      'nova-3',
      'nova-2',
      'nova-3',
      'flux-general-en',
      'flux-general-multi',
    ]);
    expect(DEEPGRAM_STT_OPTIONS).toHaveLength(5);
    expect(DEEPGRAM_STT_OPTIONS.every((option) => option.streaming)).toBe(true);
  });

  it('calculates literal minute costs and $10 duration with stable rounding', () => {
    expect(calculateDeepgramCost('nova-3-mono', 125)).toEqual({
      minutes: 125,
      costUsd: 0.6,
    });
    expect(calculateDeepgramCost('flux-multi', 90)).toEqual({
      minutes: 90,
      costUsd: 0.702,
    });
    expect(deepgramHoursForBudget('nova-3-mono', 10)).toBe(34.72);
  });

  it('normalizes invalid durations instead of displaying negative or non-finite costs', () => {
    expect(calculateDeepgramCost('nova-3-mono', -5)).toEqual({
      minutes: 0,
      costUsd: 0,
    });
    expect(calculateDeepgramCost('nova-3-mono', Number.POSITIVE_INFINITY)).toEqual({
      minutes: 0,
      costUsd: 0,
    });
  });

  it('builds the documented endpoint and language parameters for Nova and Flux', () => {
    const nova = new URL(deepgramListenUrl('nova-3-multi'));
    expect(nova.pathname).toBe('/v1/listen');
    expect(nova.searchParams.get('model')).toBe('nova-3');
    expect(nova.searchParams.get('language')).toBe('multi');
    expect(nova.searchParams.get('smart_format')).toBe('true');

    const flux = new URL(deepgramListenUrl('flux-multi'));
    expect(flux.pathname).toBe('/v2/listen');
    expect(flux.searchParams.get('model')).toBe('flux-general-multi');
    expect(flux.searchParams.has('language')).toBe(false);
    expect(flux.searchParams.has('smart_format')).toBe(false);
  });

  it('marks a pricing snapshot stale only after the documented freshness window', () => {
    expect(isDeepgramPriceStale(new Date('2026-10-31T23:59:59Z'))).toBe(false);
    expect(isDeepgramPriceStale(new Date('2026-11-01T00:00:01Z'))).toBe(true);
  });

  it('never labels prices current after a failed refresh', () => {
    const failed = getDeepgramPriceFreshness(new Date('2026-08-03T00:00:00Z'), {
      refreshFailed: true,
    });
    expect(failed.isCurrent).toBe(false);
    expect(failed.status).toBe('refresh_failed');
  });
});
