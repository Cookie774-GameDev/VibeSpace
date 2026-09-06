import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/harness/openCodeNativeTransport', () => ({
  nativeOpenCodeRequest: native.request,
  nativeOpenCodeEvents: vi.fn(),
}));
vi.mock('@/lib/harness/runtimeManager', () => ({
  harnessRuntimeManager: {
    getConnection: () => ({
      generation: 'opencode-server-startup',
      source: 'managed',
      version: '1',
    }),
    refresh: vi.fn(),
  },
}));
import {
  disposeOpenCodePersistentRuntimes,
  invalidateOpenCodePersistentCaches,
  openCodePersistentAdapter,
} from './opencodePersistent';

describe('OpenCode startup catalog', () => {
  afterEach(async () => {
    invalidateOpenCodePersistentCaches();
    await disposeOpenCodePersistentRuntimes();
    vi.clearAllMocks();
  });

  it('loads provider status and models concurrently, but waits for authentication before publishing', async () => {
    let resolveStatus!: (response: Response) => void;
    const status = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    native.request.mockImplementation(async (_generation: string, path: string) => {
      if (path === '/provider') return status;
      if (path === '/config/providers')
        return Response.json({
          providers: [
            { id: 'openai', models: { test: { id: 'test', name: 'Test' } } },
            { id: 'private', models: { hidden: { id: 'hidden', name: 'Hidden' } } },
          ],
        });
      return Response.json({ healthy: true, version: '1' });
    });
    let settled = false;
    const models = openCodePersistentAdapter.listModels!().then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() =>
        expect(native.request.mock.calls.some((call) => call[1] === '/config/providers')).toBe(
          true,
        ),
      );
      expect(settled).toBe(false);
    } finally {
      resolveStatus(Response.json({ connected: ['openai'] }));
    }
    expect((await models).map((model) => model.id)).toEqual(['openai/test']);
  });
});
