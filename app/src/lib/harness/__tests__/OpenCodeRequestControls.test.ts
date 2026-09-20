import { describe, expect, it } from 'vitest';
import {
  assertObservedModelMatches,
  buildOpenCodeRequestControls,
  openCodePromptModel,
  qualifiedOpenCodeModelRoute,
} from '../OpenCodeRequestControls';

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

  it('preserves exact qualified and nested OpenCode routes without double qualification', () => {
    expect(qualifiedOpenCodeModelRoute({
      connectionId: 'opencode-cli',
      providerId: 'opencode',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    })).toBe('opencode-go/deepseek-v4-flash-vision-exp');
    expect(openCodePromptModel({
      connectionId: 'opencode-cli',
      providerId: 'opencode',
      modelId: 'openrouter/openai/gpt-5.6-luna',
    })).toEqual({ providerID: 'openrouter', modelID: 'openai/gpt-5.6-luna' });
  });

  it('qualifies a direct provider model exactly once', () => {
    expect(openCodePromptModel({
      connectionId: 'openai-chatgpt-pro',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
    })).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
    });
  });

  it('keeps nested model IDs under an explicit provider authority', () => {
    expect(qualifiedOpenCodeModelRoute({
      connectionId: 'opencode-cli',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.6-luna',
    })).toBe('openrouter/openai/gpt-5.6-luna');
    expect(openCodePromptModel({
      connectionId: 'opencode-cli',
      providerId: 'openrouter',
      modelId: 'openai/gpt-5.6-luna',
    })).toEqual({ providerID: 'openrouter', modelID: 'openai/gpt-5.6-luna' });
  });
});
