import { afterEach, describe, expect, it } from 'vitest';
import {
  formatOpenCodeModelRef,
  isOpenAiSubscriptionModelAllowed,
  labelOpenAiSubscriptionModel,
  parseOpenCodeOpenAiModels,
  resolveOpenAiSubscriptionModels,
  setDiscoveredOpenAiSubscriptionModels,
} from './openCodeOpenAiCatalog';

const FALLBACK = Object.freeze([
  Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }),
]);

afterEach(() => {
  setDiscoveredOpenAiSubscriptionModels([]);
});

describe('parseOpenCodeOpenAiModels', () => {
  it('extracts refreshed OpenAI models including Spark', () => {
    const models = parseOpenCodeOpenAiModels(
      [
        'openai/gpt-5.6-sol',
        'openai/gpt-5.5',
        'openai/gpt-5.3-codex-spark',
        'gpt-5.4-mini extra notes',
        '# comment',
        'error: skipped',
      ].join('\n'),
    );
    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.3-codex-spark',
      'gpt-5.4-mini',
    ]);
    expect(models.find((model) => model.id === 'gpt-5.3-codex-spark')?.label).toBe(
      'GPT 5.3 Codex Spark',
    );
  });
});

describe('resolveOpenAiSubscriptionModels', () => {
  it('uses discovered OpenCode OpenAI models over the static Codex list', () => {
    expect(resolveOpenAiSubscriptionModels(FALLBACK)).toEqual(FALLBACK);
    setDiscoveredOpenAiSubscriptionModels([
      { id: 'gpt-5.3-codex-spark', label: labelOpenAiSubscriptionModel('gpt-5.3-codex-spark') },
    ]);
    expect(resolveOpenAiSubscriptionModels(FALLBACK).map((model) => model.id)).toEqual([
      'gpt-5.3-codex-spark',
    ]);
    expect(isOpenAiSubscriptionModelAllowed('gpt-5.3-codex-spark', FALLBACK)).toBe(true);
    expect(isOpenAiSubscriptionModelAllowed('gpt-5.6-sol', FALLBACK)).toBe(false);
  });
});

describe('formatOpenCodeModelRef', () => {
  it('qualifies OpenAI models and appends the selected reasoning variant', () => {
    expect(formatOpenCodeModelRef('gpt-5.3-codex-spark')).toBe('openai/gpt-5.3-codex-spark');
    expect(formatOpenCodeModelRef('gpt-5.3-codex-spark', 'xhigh')).toBe(
      'openai/gpt-5.3-codex-spark#xhigh',
    );
    expect(formatOpenCodeModelRef('openai/gpt-5.6-sol', 'xhigh')).toBe('openai/gpt-5.6-sol#xhigh');
  });
});
