import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalAgentPreferences } from '@/lib/ai/localAgentRuntime';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  pull: vi.fn(),
  remove: vi.fn(),
  verify: vi.fn(),
  nativeStatus: vi.fn(),
  installOllama: vi.fn(),
}));

vi.mock('@/stores/auth', () => {
  const state = {
    offlineMode: false,
    setOfflineMode: vi.fn(),
    defaultLocalModel: '',
    setDefaultLocalModel: vi.fn((model: string) => {
      state.defaultLocalModel = model;
    }),
    apiKeys: {},
    setApiKey: vi.fn(),
  };
  return {
    useAuthStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

vi.mock('@/lib/tauri', () => ({
  getNativeOllamaStatus: mocks.nativeStatus,
  installNativeOllamaWithConsent: mocks.installOllama,
  openOllamaTroubleshooting: vi.fn(async () => undefined),
}));

vi.mock('@/lib/ai/ollamaBootstrap', () => ({
  bootstrapOllamaConnection: mocks.bootstrap,
  invalidateOllamaBootstrap: vi.fn(),
}));

vi.mock('@/lib/ai', () => ({
  assertAllowedOllamaEndpoint: vi.fn(),
  connectLocalModelToChat: mocks.connect,
  listOllamaModelInfo: mocks.list,
  LOCAL_MODEL_CATALOG: [
    {
      name: 'qwen3.5:4b',
      displayName: 'Qwen3.5 4B',
      size: '3.4 GB',
      label: 'Efficient reasoning',
      blurb: 'Compact local reasoning.',
      availability: 'verified',
      sourceUrl: 'https://ollama.com/library/qwen3.5:4b',
      license: 'Apache-2.0',
      quantizationOptions: ['Q4_K_M'],
      contextTokens: 262_144,
      approximateDownloadBytes: 3_400_000_000,
      hardware: {
        ram: '8 GB system RAM recommended',
        vram: '4–6 GB VRAM recommended',
        cpuOnly: 'Practical on a modern CPU',
        speedClass: 'Fast',
      },
    },
  ],
  catalogDisplayName: () => 'Qwen3.5 4B',
  catalogFamilyName: () => 'Qwen3.5',
  ollamaBaseUrl: () => 'http://127.0.0.1:11434',
  OLLAMA_DEFAULT_BASE: 'http://127.0.0.1:11434',
  pullOllamaModel: mocks.pull,
  removeOllamaModel: mocks.remove,
  syncDiscoveredOllamaModels: vi.fn(),
  validateModelName: vi.fn(),
  verifyOllamaModelChat: mocks.verify,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { LocalModels } from './LocalModels';

const ready = {
  ready: true,
  status: {
    ready: true,
    apiReachable: true,
    installed: true,
    phase: 'ready',
    statusMsg: 'Ollama ready',
  },
};

describe('LocalModels local agent runtime settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.bootstrap.mockReset().mockResolvedValue(ready);
    mocks.connect.mockReset();
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.pull.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.verify.mockReset().mockResolvedValue({ ok: true, response: 'READY' });
    mocks.nativeStatus.mockReset().mockResolvedValue({ installed: true, running: true });
    mocks.installOllama.mockReset().mockResolvedValue({
      ready: true,
      apiReachable: true,
      installed: true,
      phase: 'ready',
    });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ quota: 100_000_000_000, usage: 0 })) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('persists explicit Fast, Deep, and cloud-escalation choices', () => {
    render(<LocalModels active={false} />);

    const fast = screen.getByRole('button', { name: 'Fast mode' });
    const deep = screen.getByRole('button', { name: 'Deep mode' });
    const escalation = screen.getByRole('switch', { name: 'Allow cloud escalation offers' });

    expect(fast.getAttribute('aria-pressed')).toBe('true');
    expect(deep.getAttribute('aria-pressed')).toBe('false');
    expect(escalation.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(deep);
    fireEvent.click(escalation);

    expect(readLocalAgentPreferences()).toEqual({
      mode: 'deep',
      cloudEscalationEnabled: true,
    });
  });

  it('shows exact resource guidance and never marks the requested model Recommended', () => {
    render(<LocalModels active={false} />);

    expect(screen.getByText('Qwen3.5 4B')).toBeTruthy();
    expect(screen.getByText(/3.4 GB download · 8 GB system RAM recommended/)).toBeTruthy();
    expect(screen.getByText(/CPU-only: Practical on a modern CPU · Speed: Fast/)).toBeTruthy();
    expect(screen.getByText(/256K context · Apache-2.0 · Q4_K_M/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Official model source/ }).getAttribute('href')).toBe(
      'https://ollama.com/library/qwen3.5:4b',
    );
    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('establishes Ollama, pulls, and chat-verifies without forcing a default or offline mode', async () => {
    render(<LocalModels active={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith('qwen3.5:4b', expect.anything()));
    expect(mocks.bootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pull.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pull.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verify.mock.invocationCallOrder[0]!,
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('labels installed models as automatically available in Chat', async () => {
    mocks.list.mockResolvedValue([
      { name: 'qwen3.5:4b', size: 3_400_000_000 },
      { name: 'llama3.2:3b', size: 2_000_000_000 },
    ]);
    render(<LocalModels />);

    expect(await screen.findByText('qwen3.5:4b')).toBeTruthy();
    expect(screen.getByText('llama3.2:3b')).toBeTruthy();
    expect(screen.getAllByText('Available in Chat')).toHaveLength(2);
    expect(screen.queryByRole('radiogroup', { name: 'Installed local models' })).toBeNull();
  });

  it('requires explicit consent before installing missing Ollama', async () => {
    mocks.nativeStatus.mockResolvedValue({ installed: false, running: false });
    render(<LocalModels active={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(mocks.installOllama).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/install Ollama/i));
    expect(vi.mocked(window.confirm).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.installOllama.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(mocks.pull).toHaveBeenCalled());
  });

  it('performs no install, connection, or download when consent is declined', async () => {
    mocks.nativeStatus.mockResolvedValue({ installed: false, running: false });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    render(<LocalModels active={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(mocks.installOllama).not.toHaveBeenCalled();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });

  it('cancels the real pull and truthfully omits unsupported pause', async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.pull.mockImplementation(
      (_model: string, _progress: unknown, signal: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    render(<LocalModels active={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel model download' });
    expect(screen.queryByRole('button', { name: /Pause/i })).toBeNull();
    expect(screen.getByText(/Ollama does not support pausing/)).toBeTruthy();
    fireEvent.click(cancel);

    await waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('forces repair and update, and requires confirmation before removal', async () => {
    mocks.list.mockResolvedValue([{ name: 'qwen3.5:4b', size: 3_400_000_000 }]);
    render(<LocalModels />);

    const repair = await screen.findByRole('button', { name: 'Repair' });
    fireEvent.click(repair);
    await waitFor(() =>
      expect(mocks.pull).toHaveBeenCalledWith(
        'qwen3.5:4b',
        expect.any(Function),
        expect.any(AbortSignal),
        { force: true },
      ),
    );

    mocks.pull.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(mocks.pull).toHaveBeenCalledWith(
        'qwen3.5:4b',
        expect.any(Function),
        expect.any(AbortSignal),
        { force: true },
      ),
    );

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mocks.remove).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('qwen3.5:4b'));
  });

  it('blocks a download before connection when measured storage is insufficient', async () => {
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn(async () => ({ quota: 2_000_000_000, usage: 1_000_000_000 })) },
    });
    render(<LocalModels active={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(window.navigator.storage.estimate).toHaveBeenCalled());
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.pull).not.toHaveBeenCalled();
  });
});
