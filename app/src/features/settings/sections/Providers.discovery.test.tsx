import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  state: {
    apiKeys: { openrouter: 'old-test-key' } as Record<string, string>,
    setApiKey: vi.fn(), clearApiKey: vi.fn(), defaultProvider: 'openrouter',
    setDefaultProvider: vi.fn(), plan: null, offlineMode: false, defaultLocalModel: '',
  },
  load: vi.fn(), refresh: vi.fn(),
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('../components/DeepgramCredentialCard', () => ({ DeepgramCredentialCard: () => null }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign((selector: (state: typeof fixtures.state) => unknown) => selector(fixtures.state), {
    getState: () => fixtures.state,
  }),
}));
vi.mock('@/lib/ai/providerModelCatalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ai/providerModelCatalog')>(),
  loadProviderModels: fixtures.load, refreshProviderModels: fixtures.refresh,
}));

import { Providers } from './Providers';

describe('Providers discovery ownership', () => {
  beforeEach(() => {
    fixtures.state.apiKeys = { openrouter: 'old-test-key' };
    fixtures.load.mockReset().mockImplementation(async (provider, context) =>
      provider === 'openrouter' && context.apiKeys.openrouter ? [{
        id: 'test-model', label: context.apiKeys.openrouter === 'new-test-key' ? 'New account model' : 'Old account model',
        provider: 'openrouter', availability: 'stable',
      }] : []);
    fixtures.refresh.mockReset();
  });
  afterEach(cleanup);

  it('ignores a manual refresh from the previous credential after reconnect', async () => {
    let finish!: (value: unknown[]) => void;
    fixtures.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<Providers />);
    await screen.findByText('Old account model');
    const row = document.getElementById('key-openrouter')!.closest('.jarvis-provider-key-card')!;
    fireEvent.click(Array.from(row.querySelectorAll('button')).find((button) => button.textContent?.includes('Refresh models'))!);
    fixtures.state.apiKeys = { openrouter: 'new-test-key' };
    view.rerender(<Providers />);
    await screen.findByText('New account model');
    await act(async () => { finish([{ id: 'retired-test-model', label: 'Retired account model', provider: 'openrouter', availability: 'stable' }]); });
    expect(screen.queryByText('Retired account model')).toBeNull();
    expect(screen.getByText('New account model')).toBeTruthy();
  });

  it('notifies catalog discovery when a saved credential is removed', async () => {
    const view = render(<Providers />);
    await screen.findByText('Old account model');
    fixtures.load.mockClear();
    fixtures.state.apiKeys = {};
    view.rerender(<Providers />);
    await waitFor(() => expect(fixtures.load).toHaveBeenCalledWith('openrouter', expect.objectContaining({ apiKeys: {} })));
    expect(screen.queryByText('Old account model')).toBeNull();
  });
});
