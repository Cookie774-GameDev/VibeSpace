import { describe, expect, it } from 'vitest';
import { assertObservedModelMatches, buildOpenCodeRequestControls } from '../OpenCodeRequestControls';

describe('OpenCodeRequestControls', () => {
  it('keeps connection, model, effort, Fast mode, RLM, and performance orthogonal', () => {
    expect(buildOpenCodeRequestControls({
      connectionId: 'openai-chatgpt-pro',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      runtime: { effort: 'max', serviceTier: 'fast' },
      performance: 'quality',
      rlmEnabled: true,
    })).toEqual({
      connectionId: 'openai-chatgpt-pro',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      effort: 'max',
      serviceTier: 'fast',
      performance: 'quality',
      rlmEnabled: true,
    });
  });

  it('accepts the upstream fast/priority response-name alias', () => {
    expect(() => assertObservedModelMatches({
      requested: {
        connectionId: 'openai-api',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        serviceTier: 'fast',
      },
      observed: {
        connectionId: 'openai-api',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        serviceTier: 'priority',
      },
    })).not.toThrow();
  });

  it('fails closed when route, model, or variant differs', () => {
    expect(() => assertObservedModelMatches({
      requested: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'max',
      },
      observed: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-luna',
        variant: 'medium',
      },
    })).toThrow(/MODEL_IDENTITY_MISMATCH/u);
  });
});
