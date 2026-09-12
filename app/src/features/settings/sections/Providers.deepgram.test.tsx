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
      configured: true,
      health: 'connected',
      projectName: 'VibeSpace Voice',
    })),
    testDeepgramCredential: vi.fn(async () => ({
      configured: true,
      health: 'connected',
      projectName: 'VibeSpace Voice',
    })),
    getDeepgramApiKey: vi.fn(async () => undefined),
  };
});

import { Providers } from './Providers';

describe('Providers Deepgram registration', () => {
  it('registers Deepgram in major providers with official identity and verified services', async () => {
    render(<Providers />);

    expect(
      await screen.findByRole('region', { name: 'Deepgram provider credential' }),
    ).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(
      screen.getByText('Speech-to-text (Nova/Flux) · text-to-speech (Aura) · voice services'),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Deepgram' })).toBeTruthy();
    expect(document.querySelector('.jarvis-deepgram-credential-card img')).toBeNull();
    expect(screen.getByText('VibeSpace estimate')).toBeTruthy();
    expect(screen.getByText('Deepgram project usage')).toBeTruthy();
  });
});
