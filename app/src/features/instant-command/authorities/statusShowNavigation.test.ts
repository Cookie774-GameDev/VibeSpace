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
