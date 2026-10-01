import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { getDiscoveredOllamaModels, syncDiscoveredOllamaModels } from './models';
import {
  bootstrapOllamaConnection,
  invalidateOllamaBootstrap,
  sanitizeOllamaEndpointFromStore,
} from './ollamaBootstrap';

vi.mock('@/lib/harness/localModelRuntimeRefresh', () => ({
  refreshOpenCodeLocalModelRuntime: vi.fn(),
}));

vi.mock('./providers/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/ollama')>();
  return {
    ...actual,
    isOllamaReachable: vi.fn(),
    ensureOllamaReadySilent: vi.fn(),
    listOllamaModelInfo: vi.fn(),
  };
});

import {
  ensureOllamaReadySilent,
  isOllamaReachable,
  listOllamaModelInfo,
  normalizeStoredOllamaEndpoint,
} from './providers/ollama';
import { refreshOpenCodeLocalModelRuntime } from '@/lib/harness/localModelRuntimeRefresh';

describe('normalizeStoredOllamaEndpoint', () => {
  it('rejects API keys masquerading as URLs', () => {
    expect(normalizeStoredOllamaEndpoint('sk-test-key')).toBe('http://127.0.0.1:11434');
    expect(normalizeStoredOllamaEndpoint('AIzaSyExample')).toBe('http://127.0.0.1:11434');
  });

  it('keeps valid loopback URLs', () => {
    expect(normalizeStoredOllamaEndpoint('http://localhost:11434/')).toBe('http://localhost:11434');
  });
});

describe('bootstrapOllamaConnection', () => {
  beforeEach(() => {
    invalidateOllamaBootstrap();
    syncDiscoveredOllamaModels([]);
    useAuthStore.setState({
      apiKeys: { ollama: 'http://127.0.0.1:11434' },
      defaultLocalModel: '',
    });
    vi.mocked(isOllamaReachable).mockReset();
    vi.mocked(ensureOllamaReadySilent).mockReset();
    vi.mocked(listOllamaModelInfo).mockReset();
    vi.mocked(refreshOpenCodeLocalModelRuntime).mockReset();
    vi.mocked(refreshOpenCodeLocalModelRuntime).mockResolvedValue(undefined);
  });

  it('syncs discovered models when already reachable', async () => {
    vi.mocked(isOllamaReachable).mockResolvedValue(true);
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'llama3.2:1b', size: 1, modifiedAt: 'now' },
    ]);

    const result = await bootstrapOllamaConnection({ force: true });

    expect(result.ready).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(useAuthStore.getState().defaultLocalModel).toBe('llama3.2:1b');
    expect(refreshOpenCodeLocalModelRuntime).toHaveBeenCalledTimes(1);
  });

  it('does not rotate OpenCode when the discovered local model set is unchanged', async () => {
    syncDiscoveredOllamaModels(['llama3.2:1b']);
    vi.mocked(isOllamaReachable).mockResolvedValue(true);
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'llama3.2:1b', size: 1, modifiedAt: 'now' },
    ]);

    await bootstrapOllamaConnection({ force: true });

    expect(refreshOpenCodeLocalModelRuntime).not.toHaveBeenCalled();
  });

  it('auto-starts via ensure when daemon is down', async () => {
    vi.mocked(isOllamaReachable).mockResolvedValue(false);
    vi.mocked(ensureOllamaReadySilent).mockResolvedValue({
      ready: true,
      apiReachable: true,
      installed: true,
      phase: 'ready',
      detail: 'started',
      statusMsg: 'Ollama ready',
    });
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'qwen3:0.6b', size: 1, modifiedAt: 'now' },
    ]);

    const result = await bootstrapOllamaConnection({ force: true });

    expect(ensureOllamaReadySilent).toHaveBeenCalled();
    expect(result.modelCount).toBe(1);
  });

  it('does not cache failed bootstrap attempts', async () => {
    vi.mocked(isOllamaReachable).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(ensureOllamaReadySilent).mockResolvedValue({
      ready: false,
      apiReachable: false,
      installed: true,
      phase: 'error',
      detail: 'not yet',
      statusMsg: 'error',
    });
    vi.mocked(listOllamaModelInfo).mockResolvedValue([]);

    const first = await bootstrapOllamaConnection({ force: true });
    expect(first.ready).toBe(false);

    vi.mocked(ensureOllamaReadySilent).mockResolvedValue({
      ready: true,
      apiReachable: true,
      installed: true,
      phase: 'ready',
      detail: 'ready',
      statusMsg: 'Ollama ready',
    });
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'llama3.2:1b', size: 1, modifiedAt: 'now' },
    ]);

    const second = await bootstrapOllamaConnection({ force: true });
    expect(second.ready).toBe(true);
    expect(second.modelCount).toBe(1);
  });

  it('isolates caller cancellation while sharing one in-flight bootstrap', async () => {
    let finishProbe: ((reachable: boolean) => void) | undefined;
    vi.mocked(isOllamaReachable).mockImplementation(
      (signal) =>
        new Promise<boolean>((resolve, reject) => {
          finishProbe = resolve;
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted by caller', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'llama3.2:latest', size: 1, modifiedAt: 'now' },
    ]);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = bootstrapOllamaConnection({
      force: true,
      signal: firstController.signal,
    });
    const second = bootstrapOllamaConnection({
      force: true,
      signal: secondController.signal,
    });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    finishProbe?.(true);
    await expect(second).resolves.toMatchObject({ ready: true, modelCount: 1 });
    expect(isOllamaReachable).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-aborted caller before starting provider work', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      bootstrapOllamaConnection({ force: true, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(isOllamaReachable).not.toHaveBeenCalled();
    expect(ensureOllamaReadySilent).not.toHaveBeenCalled();
    expect(listOllamaModelInfo).not.toHaveBeenCalled();
  });

  it('does not start an orphan bootstrap when cancellation lands during the ready-cache probe', async () => {
    vi.mocked(isOllamaReachable).mockResolvedValue(true);
    vi.mocked(listOllamaModelInfo).mockResolvedValue([
      { name: 'llama3.2:latest', size: 1, modifiedAt: 'now' },
    ]);
    await bootstrapOllamaConnection({ force: true });

    vi.clearAllMocks();
    useAuthStore.setState({ defaultLocalModel: 'llama3.2:latest' });
    const controller = new AbortController();
    vi.mocked(listOllamaModelInfo).mockImplementation(
      (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cache probe cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );

    const cancelled = bootstrapOllamaConnection({ signal: controller.signal });
    await vi.waitFor(() => expect(listOllamaModelInfo).toHaveBeenCalledTimes(1));
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();

    await rejected;
    await Promise.resolve();
    expect(isOllamaReachable).not.toHaveBeenCalled();
    expect(ensureOllamaReadySilent).not.toHaveBeenCalled();
    expect(listOllamaModelInfo).toHaveBeenCalledTimes(1);
    expect(getDiscoveredOllamaModels()).toEqual(['llama3.2:latest']);
    expect(useAuthStore.getState().defaultLocalModel).toBe('llama3.2:latest');
  });

  it('sanitizes a bad stored endpoint before connecting', () => {
    useAuthStore.setState({ apiKeys: { ollama: 'sk-not-a-url' } });
    sanitizeOllamaEndpointFromStore();
    expect(useAuthStore.getState().apiKeys.ollama).toBe('http://127.0.0.1:11434');
  });
});
