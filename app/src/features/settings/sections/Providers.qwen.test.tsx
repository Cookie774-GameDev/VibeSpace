import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }));
vi.mock('@/stores/auth', () => {
  const state = {
    apiKeys: {},
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    defaultProvider: 'ollama',
    setDefaultProvider: vi.fn(),
    plan: null,
    offlineMode: false,
    defaultLocalModel: 'qwen3.5:4b',
  };
  return {
    useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/lib/deepgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram')>();
  return {
    ...actual,
    loadDeepgramCredential: vi.fn(async () => ({
      configured: false,
      health: 'unconfigured',
    })),
    testDeepgramCredential: vi.fn(),
    getDeepgramApiKey: vi.fn(async () => undefined),
  };
});

import { Providers } from './Providers';

describe('Providers Qwen registration', () => {
  it('offers Qwen as a secure BYOK provider and default chat provider', () => {
    render(<Providers />);

    expect(screen.getAllByText('Qwen / Alibaba Cloud').length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('sk-... (Model Studio)')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Qwen / Alibaba Cloud logo' })).toBeTruthy();
  });
});
