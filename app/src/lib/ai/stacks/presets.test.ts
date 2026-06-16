import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CUSTOM_STEPS,
  stepsForPreset,
} from './presets';

describe('Hive presets', () => {
  it('builds the Quality topology from the Hive spec', () => {
    const steps = stepsForPreset('quality', 'general');

    expect(steps.map((step) => [step.id, step.provider, step.model])).toEqual([
      ['orient', 'xai', 'grok-4.3'],
      ['draft', 'anthropic', 'claude-opus-4-8'],
      ['harden', 'openai', 'gpt-5.5-codex'],
      ['polish', 'google', 'gemini-3.5-flash'],
    ]);
    expect(steps[0]).toMatchObject({
      provider_options: { reasoning_effort: 'high' },
    });
  });

  it('builds Ultra as the five-step Supernova stack', () => {
    const steps = stepsForPreset('ultra', 'general');

    expect(steps.map((step) => [step.id, step.provider, step.model])).toEqual([
      ['plan', 'anthropic', 'claude-opus-4-8'],
      ['implement', 'deepseek', 'deepseek-v4-pro'],
      ['harden', 'openai', 'gpt-5.5-codex'],
      ['security', 'anthropic', 'claude-opus-4-8'],
      ['polish', 'google', 'gemini-3.5-flash'],
    ]);
  });

  it('builds Fast and Balanced from the new simulation tier doc', () => {
    expect(stepsForPreset('fast', 'general').map((step) => [step.provider, step.model])).toEqual([
      ['google', 'gemini-3.5-flash'],
      ['anthropic', 'claude-opus-4-8'],
    ]);
    expect(stepsForPreset('balanced', 'general').map((step) => [step.provider, step.model])).toEqual([
      ['xai', 'grok-4.3'],
      ['anthropic', 'claude-opus-4-8'],
      ['google', 'gemini-3.5-flash'],
    ]);
  });

  it('uses task overrides for Quality code work', () => {
    const steps = stepsForPreset('quality', 'code');

    expect(steps.map((step) => [step.id, step.provider, step.model])).toEqual([
      ['plan', 'anthropic', 'claude-opus-4-8'],
      ['implement', 'deepseek', 'deepseek-v4-pro'],
      ['review', 'openai', 'gpt-5.5-codex'],
      ['security', 'anthropic', 'claude-opus-4-8'],
    ]);
  });

  it('uses custom steps when Custom is selected', () => {
    const steps = stepsForPreset('custom', 'general');

    expect(steps).toEqual(DEFAULT_CUSTOM_STEPS);
  });
});
