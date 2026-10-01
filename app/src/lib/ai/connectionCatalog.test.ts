import { describe, expect, it, beforeEach } from 'vitest';
import { CHAT_MODEL_OPTIONS } from './models';
import {
  connectionCatalogIdentity,
  getDiscoveredConnectionModels,
  parseCliModelList,
  parseOpenAiCompatibleModelList,
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from './connectionCatalog';
import { buildConnectionPickerGroups } from './useAccessibleChatModels';
import { DEEPSEEK_API_CONNECTION } from './adapters/nativeCatalog';

describe('connection catalog discovery', () => {
  beforeEach(() => {
    resetDiscoveredConnectionModelsForTests();
  });

  it('parses a provider /models payload without requiring a VibeSpace static entry', () => {
    expect(CHAT_MODEL_OPTIONS.some((option) => option.id === 'deepseek-v4-pro-live')).toBe(false);
    const discovered = parseOpenAiCompatibleModelList(
      { data: [{ id: 'deepseek-v4-pro-live', object: 'model' }, { id: 'text-embedding-3' }] },
      'provider_list',
      1_786_748_000_000,
    );
    expect(discovered.map((model) => model.id)).toEqual(['deepseek-v4-pro-live']);
  });

  it('surfaces a newly discovered model on the picker without a CHAT_MODEL_OPTIONS change', () => {
    setDiscoveredConnectionModels('deepseek-api', [
      {
        id: 'deepseek-v4-pro-live',
        label: 'DeepSeek V4 Pro Live',
        source: 'provider_list',
        lastVerifiedAt: 1,
      },
    ]);
    const groups = buildConnectionPickerGroups({
      connections: [DEEPSEEK_API_CONNECTION],
      modelsByProvider: {},
      modelsByConnection: {
        'deepseek-api': getDiscoveredConnectionModels('deepseek-api').map((model) => ({
          id: model.id,
          label: model.label,
        })),
      },
      stateByConnection: {
        'deepseek-api': { available: true, auth: 'authenticated' },
      },
      credentialSavedByProvider: { deepseek: true },
    });
    expect(groups[0]?.options.map((option) => option.modelId)).toEqual(['deepseek-v4-pro-live']);
  });

  it('keeps Z.AI API and Z.AI Coding Plan catalogs distinct', () => {
    expect(connectionCatalogIdentity('zai-api')).toEqual({
      connectionId: 'zai-api',
      catalogAuthority: 'provider_list',
      billingMode: 'payg',
    });
    expect(connectionCatalogIdentity('zai-coding-plan')).toEqual({
      connectionId: 'zai-coding-plan',
      catalogAuthority: 'opencode_refresh',
      billingMode: 'subscription',
    });
  });

  it('parses an OpenCode Z.AI refresh list without a static CHAT_MODEL_OPTIONS entry', () => {
    expect(CHAT_MODEL_OPTIONS.some((option) => option.id === 'glm-5-turbo-live')).toBe(false);
    const discovered = parseCliModelList(
      'zai/glm-5-turbo-live  ready\n# comment\nerror ignored\nglm-5.1',
      'opencode_refresh',
      2,
    );
    expect(discovered.map((model) => model.id)).toEqual(['zai/glm-5-turbo-live', 'glm-5.1']);
    setDiscoveredConnectionModels('zai-coding-plan', discovered);
    expect(getDiscoveredConnectionModels('zai-coding-plan').map((model) => model.id)).toEqual([
      'zai/glm-5-turbo-live',
      'glm-5.1',
    ]);
  });
});
