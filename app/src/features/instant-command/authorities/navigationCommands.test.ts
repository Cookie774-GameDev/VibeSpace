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
  };
  return port;
}

describe('executeNavigationCommand', () => {
  it('acknowledges a route before any lazy page chunk renders', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand({ id: 'page.open', slots: { route: 'terminal' } }, port),
    ).resolves.toEqual({ ok: true, code: 'opened', message: 'Opened terminal.' });
    expect(port.openRoute).toHaveBeenCalledWith('terminal');
  });

  it('fails closed when a detail page has no unique selected entity', async () => {
    const port = authority();
    vi.mocked(port.hasSelectedAgent).mockReturnValue(false);
    await expect(
      executeNavigationCommand({ id: 'page.open', slots: { route: 'agent-detail' } }, port),
    ).resolves.toEqual({
      ok: false,
      code: 'target_missing',
      message: 'Select one agent before opening agent details.',
    });
    expect(port.openRoute).not.toHaveBeenCalled();
  });

  it('uses the typed settings section and shell overlay authorities', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand({ id: 'settings.section.open', slots: { section: 'voice' } }, port),
    ).resolves.toMatchObject({ ok: true, code: 'opened' });
    expect(port.openSettings).toHaveBeenCalledWith('voice');

    await executeNavigationCommand({ id: 'palette.open', slots: {} }, port);
    await executeNavigationCommand({ id: 'launcher.open', slots: {} }, port);
    expect(port.openPalette).toHaveBeenCalledOnce();
    expect(port.openLauncher).toHaveBeenCalledOnce();
  });

  it('reports the canonical fullscreen state rather than the requested state', async () => {
    const port = authority();
    vi.mocked(port.setFullscreen).mockResolvedValue(false);
    await expect(
      executeNavigationCommand({ id: 'fullscreen.set', slots: { enabled: true } }, port),
    ).resolves.toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Fullscreen remained off.',
    });
  });

  it('routes /connect to the existing Providers UI without accepting credential text', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand({ id: 'connections.open', slots: { section: 'providers' } }, port),
    ).resolves.toEqual({ ok: true, code: 'opened', message: 'Opened provider connections.' });
    expect(port.openSettings).not.toHaveBeenCalled();
    expect(port.openProviderConnections).toHaveBeenCalledWith(undefined);
  });

  it.each([
    [
      { section: 'providers', apiKey: 'must-not-enter-command' },
      'Provider connections do not accept command arguments.',
    ],
    [{ section: 'voice' }, 'Provider connections do not accept command arguments.'],
    [{ provider: 'openai' }, 'Provider connections do not accept command arguments.'],
    [{ section: 'providers', providerId: 'ollama' }, 'Choose one supported provider in Settings.'],
    [
      { section: 'providers', providerId: 'openai', extra: true },
      'Provider connections do not accept command arguments.',
    ],
  ] as const)(
    'rejects non-exact /connect slots before opening Providers',
    async (slots, message) => {
      const port = authority();
      const result = await executeNavigationCommand({ id: 'connections.open', slots }, port);
      expect(result).toEqual({
        ok: false,
        code: 'queue_failed',
        message,
      });
      expect(port.openSettings).not.toHaveBeenCalled();
      expect(port.openProviderConnections).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('must-not-enter-command');
    },
  );

  it('redacts navigation adapter failures from receipts', async () => {
    const port = authority();
    vi.mocked(port.openProviderConnections!).mockImplementationOnce(() => {
      throw new Error('private provider surface detail');
    });
    const result = await executeNavigationCommand(
      { id: 'connections.open', slots: { section: 'providers' } },
      port,
    );
    expect(result).toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Navigation command failed.',
    });
    expect(JSON.stringify(result)).not.toContain('private provider surface detail');
  });

  it.each(['page.destroy', 'page.open\u0000', `page.${'x'.repeat(100)}`])(
    'rejects unknown or malformed command IDs before authority access: %s',
    async (id) => {
      const port = authority();
      await expect(executeNavigationCommand({ id, slots: {} }, port)).resolves.toEqual({
        ok: false,
        code: 'queue_failed',
        message: 'That navigation command is not implemented.',
      });
      expect(Object.values(port).every((method) => vi.mocked(method).mock.calls.length === 0)).toBe(
        true,
      );
    },
  );

  it.each([
    { id: 'page.open', slots: null },
    { id: 'page.open', slots: [] },
    { id: 'page.open', slots: { route: 'terminal', apiKey: 'must-not-enter-command' } },
    { id: 'page.home', slots: { rawMessage: 'private conversation' } },
    { id: 'settings.open', slots: { section: 'providers' } },
    { id: 'fullscreen.set', slots: { enabled: true, extra: true } },
  ])('rejects non-exact slot schemas before authority access: $id', async (request) => {
    const port = authority();
    const result = await executeNavigationCommand(request as never, port);
    expect(result).toEqual({
      ok: false,
      code: 'queue_failed',
      message: 'Navigation command arguments are invalid.',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-enter-command');
    expect(JSON.stringify(result)).not.toContain('private conversation');
    expect(Object.values(port).every((method) => vi.mocked(method).mock.calls.length === 0)).toBe(
      true,
    );
  });

  it('allows /connect without arguments and still opens only the Providers surface', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand({ id: 'connections.open', slots: {} }, port),
    ).resolves.toEqual({ ok: true, code: 'opened', message: 'Opened provider connections.' });
    expect(port.openSettings).not.toHaveBeenCalled();
    expect(port.openProviderConnections).toHaveBeenCalledWith(undefined);
  });

  it('focuses one exact supported provider without accepting secret or extra arguments', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand(
        {
          id: 'connections.open',
          slots: { section: 'providers', providerId: 'openrouter' },
        },
        port,
      ),
    ).resolves.toEqual({
      ok: true,
      code: 'opened',
      message: 'Opened provider connections for openrouter.',
    });
    expect(port.openProviderConnections).toHaveBeenCalledWith('openrouter');
    expect(port.openSettings).not.toHaveBeenCalled();
  });

  it('routes an exact CLI connection target to the Connections surface', async () => {
    const port = authority();
    await expect(
      executeNavigationCommand(
        {
          id: 'connections.open',
          slots: { section: 'connections', connectionId: 'openai-codex' },
        },
        port,
      ),
    ).resolves.toEqual({
      ok: true,
      code: 'opened',
      message: 'Opened openai-codex connections.',
    });
    expect(port.openProviderConnections).toHaveBeenCalledWith('openai-codex');
  });

  it.each([undefined, null, 'true', 1])(
    'does not invent fullscreen state from a non-boolean observation: %s',
    async (observed) => {
      const port = authority();
      vi.mocked(port.setFullscreen).mockResolvedValueOnce(observed as never);
      await expect(
        executeNavigationCommand({ id: 'fullscreen.set', slots: { enabled: true } }, port),
      ).resolves.toEqual({
        ok: false,
        code: 'queue_failed',
        message: 'Fullscreen state is unavailable.',
      });
    },
  );
});
