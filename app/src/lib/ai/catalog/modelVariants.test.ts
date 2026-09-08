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
    expect(() => resolveEffortVariant('gpt-5.3-codex-spark', 'max', [{ id: 'medium' }])).toThrow(
      VariantNotAvailableError,
    );
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
    expect(
      resolveFastMode(true, {
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-sol',
        serviceTiers: ['priority'],
      }),
    ).toEqual({
      enabled: true,
      supported: true,
      transport: 'service-tier',
      serviceTier: 'fast',
      usageWarningRequired: true,
    });
  });

  it('uses native OpenCode fast or a live fast variant only when exposed', () => {
    expect(
      resolveFastMode(true, {
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        supportsOpenCodeFastMode: true,
      }),
    ).toMatchObject({
      transport: 'opencode-native',
      openCodeFastMode: true,
    });
    expect(
      resolveFastMode(true, {
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-terra',
        variants: [{ id: 'fast' }],
      }),
    ).toMatchObject({
      transport: 'variant',
      upstreamVariant: 'fast',
    });
    expect(
      resolveFastMode(true, {
        connectionId: 'opencode-cli',
        modelId: 'openai/gpt-5.6-sol',
      }),
    ).toMatchObject({ supported: false, transport: 'off' });
  });

  it('trusts live Luna efforts and orders xhigh before max', () => {
    const all = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id }));
    expect(
      listEffortOptions(all, 'openai/gpt-5.6-sol')
        .filter((item) => item.available)
        .map((item) => item.label),
    ).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'ultra', 'max']);
    expect(
      listEffortOptions(all, 'openrouter/openai/gpt-5.6-luna')
        .filter((item) => item.available)
        .map((item) => item.label),
    ).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'ultra', 'max']);
    expect(resolveEffortVariant('openai/gpt-5.6-luna', 'ultra', all)).toBe('xhigh');
  });

  it('accepts explicit live Fast capabilities without a model-name allowlist', () => {
    for (const metadata of [
      { connectionId: 'openai-api', modelId: 'gpt-5.6-sol', serviceTiers: ['fast'] },
      {
        connectionId: 'opencode-cli',
        modelId: 'openrouter/openai/gpt-5.6-sol',
        serviceTiers: ['fast'],
      },
      { connectionId: 'opencode-cli', modelId: 'qwen/qwen3.8-max', variants: [{ id: 'fast' }] },
    ]) {
      expect(resolveFastMode(true, metadata).supported).toBe(true);
    }
  });
});
