import { describe, expect, it } from 'vitest';
import {
  parseRuntimeSlashCommand,
  resolveRuntimeModelControls,
  supportedEffortPreferences,
} from '../runtimeModelControls';

const sol = {
  connectionId: 'opencode-cli',
  modelId: 'openai/gpt-5.6-sol',
  variants: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id })),
  supportsIndependentReasoningEffort: true,
  serviceTiers: ['fast'],
};

describe('runtime model controls', () => {
  it('shows only exact live effort choices', () => {
    expect(supportedEffortPreferences(sol)).toEqual([
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
      'ultra',
      'max',
    ]);
  });

  it('combines effort with real Fast service tier without changing model', () => {
    expect(resolveRuntimeModelControls({ effort: 'ultra', fastMode: 'on' }, sol)).toEqual({
      ok: true,
      controls: {
        effort: 'xhigh',
        serviceTier: 'fast',
        usageWarningRequired: true,
      },
    });
  });

  it('keeps Ultra/xhigh and Max/max as separate exact live controls', () => {
    expect(resolveRuntimeModelControls({ effort: 'ultra', fastMode: 'auto' }, sol)).toEqual({
      ok: true,
      controls: { effort: 'xhigh' },
    });
    expect(resolveRuntimeModelControls({ effort: 'max', fastMode: 'auto' }, sol)).toEqual({
      ok: true,
      controls: { effort: 'max' },
    });
  });

  it('fails closed when an effort is not backed by an exact live variant', () => {
    expect(
      resolveRuntimeModelControls(
        { effort: 'max', fastMode: 'auto' },
        { ...sol, variants: [{ id: 'xhigh' }], supportsIndependentReasoningEffort: false },
      ),
    ).toMatchObject({
      ok: false,
      code: 'EFFORT_UNSUPPORTED',
    });
  });

  it('uses OpenCode-native subscription Fast control when exposed', () => {
    expect(
      resolveRuntimeModelControls(
        { effort: 'high', fastMode: 'on' },
        { ...sol, serviceTiers: [], supportsOpenCodeFastMode: true },
      ),
    ).toEqual({
      ok: true,
      controls: {
        effort: 'high',
        openCodeFastMode: true,
        usageWarningRequired: true,
      },
    });
  });

  it('accepts advertised Fast capabilities on any exact route', () => {
    for (const metadata of [
      { ...sol, connectionId: 'openai-api', modelId: 'gpt-5.6-sol' },
      { ...sol, modelId: 'openrouter/openai/gpt-5.6-sol' },
    ]) {
      expect(
        resolveRuntimeModelControls({ effort: 'auto', fastMode: 'on' }, metadata),
      ).toMatchObject({
        ok: true,
        controls: { serviceTier: 'fast' },
      });
    }
  });

  it('keeps fixed Fast model routes executable without unsupported prompt fields', () => {
    expect(resolveRuntimeModelControls({ effort: 'ultra', fastMode: 'on' }, {
      ...sol, modelId: 'openai/gpt-5.6-luna-fast', serviceTiers: [],
      supportsIndependentReasoningEffort: false, isFastRoute: true,
    })).toEqual({ ok: true, controls: { variant: 'xhigh', usageWarningRequired: true } });
    expect(parseRuntimeSlashCommand('/effort xhigh')).toEqual({ kind: 'effort', value: 'ultra' });
    expect(parseRuntimeSlashCommand('/effort none')).toEqual({ kind: 'effort', value: 'minimal' });
  });

  it('fails unsupported Spark max and unsupported Fast before provider send', () => {
    const spark = {
      connectionId: 'openai-chatgpt-pro',
      modelId: 'gpt-5.3-codex-spark',
      variants: [{ id: 'medium' }],
    };
    expect(resolveRuntimeModelControls({ effort: 'max', fastMode: 'auto' }, spark)).toMatchObject({
      ok: false,
      code: 'EFFORT_UNSUPPORTED',
    });
    expect(resolveRuntimeModelControls({ effort: 'medium', fastMode: 'on' }, spark)).toMatchObject({
      ok: false,
      code: 'FAST_MODE_UNSUPPORTED',
    });
  });

  it('parses strict slash controls', () => {
    expect(parseRuntimeSlashCommand('/effort max')).toEqual({ kind: 'effort', value: 'max' });
    expect(parseRuntimeSlashCommand('/fast on')).toEqual({ kind: 'fast', value: 'on' });
    expect(parseRuntimeSlashCommand('/fast')).toEqual({ kind: 'fast' });
    expect(parseRuntimeSlashCommand('/fast on extra')).toBeNull();
  });
});
