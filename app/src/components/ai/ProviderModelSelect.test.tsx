import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { syncDiscoveredOllamaModels } from '@/lib/ai/models';
import { resetProviderModelCache } from '@/lib/ai/providerModelCatalog';
import { ProviderModelSelect } from './ProviderModelSelect';

vi.mock('@/lib/ai/providers/ollama', () => ({
  isOllamaReachable: vi.fn(async () => false),
  listOllamaModels: vi.fn(async () => []),
}));

vi.mock('@/lib/nativeFetch', () => ({
  nativeFetch: vi.fn(async () => {
    throw new Error('network disabled in tests');
  }),
}));

describe('ProviderModelSelect', () => {
  beforeEach(() => {
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: { deepseek: 'test-key' },
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: '',
    });
  });

  it('shows only connected provider models without manual custom entry', () => {
    render(
      <ProviderModelSelect
        providerId="deepseek"
        modelId="deepseek-v4-flash"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        providers={['deepseek']}
      />,
    );

    const modelSelect = screen.getByLabelText('Model');
    expect(modelSelect.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: /DeepSeek V4 Flash/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /DeepSeek V4 Pro/i })).toBeTruthy();
    expect(screen.queryByLabelText(/Advanced: custom model ID/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/custom-model-id/i)).toBeNull();
  });

  it('does not preserve stale custom model ids as selectable options', () => {
    render(
      <ProviderModelSelect
        providerId="deepseek"
        modelId="legacy-manual-model"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        providers={['deepseek']}
      />,
    );

    expect(screen.queryByRole('option', { name: /legacy-manual-model/i })).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/not available/i);
  });
});
