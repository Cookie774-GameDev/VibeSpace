import { describe, expect, it, vi } from 'vitest';
import { executeNavigationCommand, type NavigationAuthorityPort } from './navigationCommands';

function authority() {
  const port: NavigationAuthorityPort = {
    openRoute: vi.fn(),
    hasSelectedAgent: vi.fn(() => true),
    hasSelectedProject: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
    openSettings: vi.fn(),
    openProviderConnections: vi.fn(),
    closeSettings: vi.fn(),
    openPalette: vi.fn(),
    openLauncher: vi.fn(),
    setFullscreen: vi.fn(async (enabled: boolean) => enabled),
    readRouterStatus: vi.fn(() => ({
      state: 'ready' as const,
      catalogCommands: 12,
      availableCommands: 8,
      gatedCommands: 4,
    })),
  };
  return port;
}

describe('status.show navigation authority', () => {
  it('returns a local status receipt without opening a route or provider', async () => {
    const port = authority();
    await expect(executeNavigationCommand({ id: 'status.show', slots: {} }, port)).resolves.toEqual(
      {
        ok: true,
        code: 'opened',
        message:
          'Local command router ready — 8 available of 12 cataloged; 4 gated or unproven. No provider call was made.',
      },
    );
    expect(port.readRouterStatus).toHaveBeenCalledOnce();
    expect(port.openRoute).not.toHaveBeenCalled();
    expect(port.openProviderConnections).not.toHaveBeenCalled();
  });

  it('keeps the status command exact and rejects extra slots before reading state', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand({ id: 'status.show', slots: { private: 'must-not-leak' } }, port),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Navigation command arguments are invalid.',
    });
    expect(port.readRouterStatus).not.toHaveBeenCalled();
  });
});


describe('status.show visible result', () => {
  it('presents the validated local result exactly once without opening another surface', async () => {
    const port = { ...authority(), showRouterStatus: vi.fn() };
    const result = await executeNavigationCommand({ id: 'status.show', slots: {} }, port);
    expect(result.ok).toBe(true);
    expect(port.showRouterStatus).toHaveBeenCalledExactlyOnceWith(result.message);
    expect(port.openRoute).not.toHaveBeenCalled();
    expect(port.openProviderConnections).not.toHaveBeenCalled();
  });

  it('does not present success for invalid slot data', async () => {
    const port = { ...authority(), showRouterStatus: vi.fn() };
    const result = await executeNavigationCommand({ id: 'status.show', slots: { scope: 'unexpected' } }, port);
    expect(result.ok).toBe(false);
    expect(port.readRouterStatus).not.toHaveBeenCalled();
    expect(port.showRouterStatus).not.toHaveBeenCalled();
  });

  it('does not present a fabricated success when catalog counts are unavailable', async () => {
    const port = { ...authority(), readRouterStatus: vi.fn(() => { throw new Error('catalog unavailable'); }), showRouterStatus: vi.fn() };
    expect((await executeNavigationCommand({ id: 'status.show', slots: {} }, port)).ok).toBe(false);
    expect(port.showRouterStatus).not.toHaveBeenCalled();
  });

  it('does not present stale status when cancellation happens during its read', async () => {
    const controller = new AbortController();
    const port = { ...authority(), showRouterStatus: vi.fn(), readRouterStatus: vi.fn(() => {
      controller.abort();
      return { state: 'ready' as const, catalogCommands: 12, availableCommands: 8, gatedCommands: 4 };
    }) };
    expect((await executeNavigationCommand({ id: 'status.show', slots: {} }, port, controller.signal)).ok).toBe(false);
    expect(port.showRouterStatus).not.toHaveBeenCalled();
  });
});
