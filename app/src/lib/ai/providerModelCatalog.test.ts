import { beforeEach, describe, expect, it } from 'vitest';
import { syncDiscoveredOllamaModels } from './models';
import {
  getModelsForProvider,
  modelBelongsToProvider,
  resetProviderModelCache,
  resolveModelOnProviderChange,
  sanitizeModelIdForInput,
  validateProviderModelSelection,
} from './providerModelCatalog';

const ctx = {
  apiKeys: { google: 'test-key', groq: 'gsk_test' },
  offlineMode: false,
  plan: 'free' as const,
  defaultLocalModel: '',
};

describe('providerModelCatalog', () => {
  beforeEach(() => {
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
  });

  it('sanitizes manual model ids', () => {
    expect(sanitizeModelIdForInput('  gemini-3.5-flash \n')).toBe('gemini-3.5-flash');
  });

  it('returns Gemini models for google provider', () => {
    const models = getModelsForProvider('google', ctx);
    expect(models.some((model) => model.id === 'gemini-3.5-flash')).toBe(true);
    expect(models.every((model) => model.provider === 'google')).toBe(true);
  });

  it('clears mismatched model when provider changes', () => {
    const next = resolveModelOnProviderChange('groq', 'gemini-3.5-flash', ctx);
    expect(modelBelongsToProvider('groq', next)).toBe(true);
    expect(next).not.toBe('gemini-3.5-flash');
  });

  it('preserves unknown saved model as custom option', () => {
    const models = getModelsForProvider('google', ctx, 'my-old-custom-model');
    expect(models.some((model) => model.id === 'my-old-custom-model' && model.isCustom)).toBe(true);
  });

  it('blocks provider/model mismatch validation', () => {
    const result = validateProviderModelSelection('groq', 'gemini-3.5-flash', ctx);
    expect(result.ok).toBe(false);
  });

  it('allows advanced custom model ids when enabled', () => {
    const result = validateProviderModelSelection('google', 'totally-custom-id', ctx, {
      allowCustom: true,
    });
    expect(result.ok).toBe(true);
    expect(result.isCustomModel).toBe(true);
  });
});
