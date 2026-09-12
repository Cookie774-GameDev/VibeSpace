import { describe, expect, it } from 'vitest';
import {
  parseRuntimeSlashCommand,
  resolveRuntimeModelControls,
  supportedEffortPreferences,
} from '../runtimeModelControls';

const sol = {
  connectionId: 'openai-api',
  modelId: 'gpt-5.6-sol',
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

  it('uses OpenCode-native subscription Fast control when exposed', () => {
    expect(resolveRuntimeModelControls(
      { effort: 'high', fastMode: 'on' },
      { ...sol, serviceTiers: [], supportsOpenCodeFastMode: true },
    )).toEqual({
      ok: true,
      controls: {
        effort: 'high',
        openCodeFastMode: true,
        usageWarningRequired: true,
      },
    });
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
