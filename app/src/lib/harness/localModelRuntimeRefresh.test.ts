import { describe, expect, it, vi } from 'vitest';
import { refreshOpenCodeLocalModelRuntime } from './localModelRuntimeRefresh';

describe('OpenCode local-model config refresh', () => {
  it('rotates and refreshes only an already-running owned server', async () => {
    const stop = vi.fn(async () => true);
    const refresh = vi.fn(async () => undefined);

    await refreshOpenCodeLocalModelRuntime({
      available: () => true,
      stop,
      refresh,
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not start a server solely because the local model set changed', async () => {
    const refresh = vi.fn(async () => undefined);

    await refreshOpenCodeLocalModelRuntime({
      available: () => true,
      stop: vi.fn(async () => false),
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('is inert outside the desktop runtime', async () => {
    const stop = vi.fn(async () => true);

    await refreshOpenCodeLocalModelRuntime({
      available: () => false,
      stop,
      refresh: vi.fn(async () => undefined),
    });

    expect(stop).not.toHaveBeenCalled();
  });
});
