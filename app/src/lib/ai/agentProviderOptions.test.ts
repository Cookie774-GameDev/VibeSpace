import { beforeEach, describe, expect, it } from 'vitest';
import { syncDiscoveredOllamaModels } from './models';
import {
  AGENT_DEFAULT_PROVIDER_MODEL,
  agentEditorProviderFromAgent,
  agentModelFromEditorChoice,
  agentUsesDefaultProvider,
  getAgentEditorProviderOptions,
  isDefaultProviderSelectable,
} from './agentProviderOptions';

describe('agentProviderOptions', () => {
  beforeEach(() => {
    syncDiscoveredOllamaModels([]);
  });

  it('detects default-provider agents', () => {
    expect(agentUsesDefaultProvider('mock', AGENT_DEFAULT_PROVIDER_MODEL)).toBe(true);
    expect(agentUsesDefaultProvider('mock', 'mock-default')).toBe(false);
  });

  it('lists default provider first then accessible providers', () => {
    syncDiscoveredOllamaModels(['llama3.2']);
    const options = getAgentEditorProviderOptions({
      apiKeys: { google: 'key' },
      offlineMode: false,
      plan: 'free',
      defaultProvider: 'google',
    });
    expect(options[0]).toEqual({
      id: 'default',
      label: 'Default provider (Gemini)',
    });
    expect(options.map((o) => o.id)).toEqual(['default', 'google', 'ollama']);
  });

  it('allows subscription-hosted providers without BYOK keys', () => {
    expect(isDefaultProviderSelectable('deepseek', {}, false, 'starter')).toBe(true);
    expect(isDefaultProviderSelectable('google', {}, false, 'starter')).toBe(true);
    expect(isDefaultProviderSelectable('anthropic', {}, false, 'starter')).toBe(true);
  });

  it('maps editor default choice to stored sentinel model', () => {
    const mapped = agentModelFromEditorChoice(
      'default',
      'google',
      'gemini-2.5-flash-lite',
      {},
      false,
      'free',
      'llama3.2',
    );
    expect(mapped).toEqual({ provider: 'mock', model: AGENT_DEFAULT_PROVIDER_MODEL });
  });

  it('round-trips default provider from agent model', () => {
    expect(
      agentEditorProviderFromAgent('mock', AGENT_DEFAULT_PROVIDER_MODEL),
    ).toBe('default');
    expect(agentEditorProviderFromAgent('google', 'gemini-2.5-flash-lite')).toBe('google');
  });
});
