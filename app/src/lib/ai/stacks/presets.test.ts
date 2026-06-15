import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CUSTOM_STEPS,
  stepsForPreset,
} from './presets';

describe('Hive presets', () => {
  it('builds the Quality topology from the Hive spec', () => {
    const steps = stepsForPreset('quality', 'general');

    expect(steps.map((step) => [step.id, step.provider, step.model])).toEqual([
      ['draft', 'anthropic', 'claude-opus-4-8'],
      ['critique', 'openai', 'gpt-5.5'],
      ['polish', 'google', 'gemini-3.5-flash'],
    ]);
  });

  it('builds High with Grok X High orientation and Codex hardening', () => {
    const steps = stepsForPreset('high', 'general');

    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({
      id: 'orient',
      provider: 'xai',
      model: 'grok-4.3',
      provider_options: { reasoning_effort: 'high' },
    });
    expect(steps[2]).toMatchObject({
      id: 'harden',
      provider: 'openai',
      model: 'gpt-5.5-codex',
    });
  });

  it('uses task overrides for Quality code work', () => {
    const steps = stepsForPreset('quality', 'code');

    expect(steps.map((step) => [step.id, step.provider, step.model])).toEqual([
      ['plan', 'anthropic', 'claude-opus-4-8'],
      ['implement', 'deepseek', 'deepseek-v4-pro'],
      ['review', 'openai', 'gpt-5.5-codex'],
    ]);
  });

  it('uses custom steps when Custom is selected', () => {
    const steps = stepsForPreset('custom', 'general');

    expect(steps).toEqual(DEFAULT_CUSTOM_STEPS);
  });
});
