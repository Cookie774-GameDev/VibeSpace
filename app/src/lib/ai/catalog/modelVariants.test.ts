import { describe, expect, it } from 'vitest';
import {
  VariantNotAvailableError,
  listEffortOptions,
  resolveEffortVariant,
  resolveFastMode,
} from './modelVariants';

describe('model-specific variants and fast mode', () => {
  const sol = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id }));

  it('maps VibeSpace effort labels only to live variants', () => {
    expect(resolveEffortVariant('gpt-5.6-sol', 'minimal', sol)).toBe('none');
    expect(resolveEffortVariant('gpt-5.6-sol', 'ultra', sol)).toBe('xhigh');
    expect(resolveEffortVariant('gpt-5.6-sol', 'max', sol)).toBe('max');
    expect(resolveEffortVariant('gpt-5.6-sol', 'auto', sol)).toBeUndefined();
  });

  it('rejects unsupported stale effort rather than silently downgrading', () => {
    expect(() => resolveEffortVariant('gpt-5.3-codex-spark', 'max', [{ id: 'medium' }]))
      .toThrow(VariantNotAvailableError);
  });

  it('filters effort autocomplete to the exact selected model', () => {
    const options = listEffortOptions([{ id: 'low' }, { id: 'medium' }]);
    expect(options.filter((item) => item.available).map((item) => item.label)).toEqual([
      'auto',
      'low',
      'medium',
    ]);
  });

  it('prefers the exact Fast service tier and preserves model identity', () => {
    expect(resolveFastMode(true, { serviceTiers: ['priority'] })).toEqual({
      enabled: true,
      supported: true,
      transport: 'service-tier',
      serviceTier: 'fast',
      usageWarningRequired: true,
    });
  });

  it('uses native OpenCode fast or a live fast variant only when exposed', () => {
    expect(resolveFastMode(true, { supportsOpenCodeFastMode: true })).toMatchObject({
      transport: 'opencode-native',
      openCodeFastMode: true,
    });
    expect(resolveFastMode(true, [{ id: 'fast' }])).toMatchObject({
      transport: 'variant',
      upstreamVariant: 'fast',
    });
    expect(resolveFastMode(true, [])).toMatchObject({ supported: false, transport: 'off' });
  });
});
