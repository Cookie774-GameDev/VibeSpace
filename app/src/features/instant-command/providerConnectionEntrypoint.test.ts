import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import {
  CONNECT_PROVIDER_FOCUS_IDS,
  CONNECT_CONNECTION_FOCUS_IDS,
  CONNECTION_FOCUS_STORAGE_KEY,
  openProviderConnectionEntrypoint,
  parseProviderConnectionTarget,
  type ProviderConnectionEntrypointPort,
} from './providerConnectionEntrypoint';

function authority(open = false) {
  const scheduled: Array<() => void> = [];
  const port: ProviderConnectionEntrypointPort = {
    isSettingsOpen: vi.fn(() => open),
    rememberProviders: vi.fn(),
    rememberConnections: vi.fn(),
    persistProviderFocus: vi.fn(),
    persistConnectionFocus: vi.fn(),
    setSettingsOpen: vi.fn(),
    emitProvidersTab: vi.fn(),
    emitConnectionsTab: vi.fn(),
    emitProviderFocus: vi.fn(),
    emitConnectionFocus: vi.fn(),
    schedule: vi.fn((callback) => scheduled.push(callback)),
  };
  return { port, scheduled };
}

describe('provider connection entrypoint', () => {
  it('binds every focus target to a real enabled nonlocal connection and excludes local routes', () => {
    const connectedProviders = new Set(
      PROVIDER_CONNECTIONS.filter(
        (connection) => connection.enabled && connection.mode !== 'local',
      ).map((connection) => connection.providerId),
    );
    expect(CONNECT_PROVIDER_FOCUS_IDS).toEqual([
      'anthropic',
      'deepseek',
      'google',
      'groq',
      'mistral',
      'openai',
      'openrouter',
      'qwen',
      'together',
      'xai',
    ]);
    expect(
      CONNECT_PROVIDER_FOCUS_IDS.every((providerId) => connectedProviders.has(providerId)),
    ).toBe(true);
    expect(CONNECT_PROVIDER_FOCUS_IDS).not.toContain('ollama');
    expect(JSON.stringify(CONNECT_PROVIDER_FOCUS_IDS)).not.toMatch(/11434/iu);
  });

  it('parses only an empty target or one exact supported provider ID without reflecting rejects', () => {
    expect(parseProviderConnectionTarget('')).toEqual({ ok: true, providerId: undefined });
    expect(parseProviderConnectionTarget('openai')).toEqual({ ok: true, providerId: 'openai' });
    for (const value of [
      'ollama',
      'unknown',
      'openai extra',
      'sk-live-secret',
      'apiKey=private',
      'openai\u0000secret',
      'x'.repeat(97),
    ]) {
      const result = parseProviderConnectionTarget(value);
      expect(result).toEqual({ ok: false, reason: 'Choose one supported provider in Settings.' });
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it('parses CLI aliases to exact managed connection IDs', () => {
    expect(CONNECT_CONNECTION_FOCUS_IDS).toEqual(['openai-codex', 'opencode-cli']);
    expect(parseProviderConnectionTarget('codex')).toEqual({
      ok: true,
      providerId: undefined,
      connectionId: 'openai-codex',
    });
    expect(parseProviderConnectionTarget('opencode')).toEqual({
      ok: true,
      providerId: undefined,
      connectionId: 'opencode-cli',
    });
  });

  it('persists only the safe focus ID before opening and replays existing tab/focus events', () => {
    const { port, scheduled } = authority(false);
    expect(openProviderConnectionEntrypoint('openai', port)).toEqual({ ok: true });
    expect(port.rememberProviders).toHaveBeenCalledBefore(vi.mocked(port.setSettingsOpen));
    expect(port.persistProviderFocus).toHaveBeenCalledWith('openai');
    expect(port.setSettingsOpen).toHaveBeenCalledWith(true);
    expect(port.emitProvidersTab).not.toHaveBeenCalled();
    expect(port.emitProviderFocus).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(port.emitProvidersTab).toHaveBeenCalledOnce();
    expect(port.emitProviderFocus).toHaveBeenCalledWith('openai');
  });

  it('opens bare Providers without persisting focus and fails closed before authority access', () => {
    const bare = authority(true);
    expect(openProviderConnectionEntrypoint(undefined, bare.port)).toEqual({ ok: true });
    expect(bare.port.persistProviderFocus).not.toHaveBeenCalled();
    expect(bare.port.rememberConnections).toHaveBeenCalledOnce();
    expect(bare.port.emitConnectionsTab).toHaveBeenCalledOnce();
    expect(bare.port.emitProviderFocus).not.toHaveBeenCalled();

    const rejected = authority();
    expect(openProviderConnectionEntrypoint('ollama', rejected.port)).toEqual({
      ok: false,
      reason: 'Choose one supported provider in Settings.',
    });
    expect(
      Object.values(rejected.port).every((method) => vi.mocked(method).mock.calls.length === 0),
    ).toBe(true);
  });

  it('opens each CLI target in Connections and persists only its exact safe ID', () => {
    for (const [alias, connectionId] of [
      ['codex', 'openai-codex'],
      ['opencode', 'opencode-cli'],
    ] as const) {
      const { port, scheduled } = authority(false);
      expect(openProviderConnectionEntrypoint(alias, port)).toEqual({ ok: true });
      expect(port.rememberConnections).toHaveBeenCalledOnce();
      expect(port.persistConnectionFocus).toHaveBeenCalledWith(connectionId);
      expect(port.rememberProviders).not.toHaveBeenCalled();
      scheduled[0]!();
      expect(port.emitConnectionsTab).toHaveBeenCalledOnce();
      expect(port.emitConnectionFocus).toHaveBeenCalledWith(connectionId);
      expect(JSON.stringify(vi.mocked(port.persistConnectionFocus).mock.calls)).not.toContain(
        'secret',
      );
    }
    expect(CONNECTION_FOCUS_STORAGE_KEY).toBe('vibespace.settings.connection-focus.v1');
  });

  it('keeps provider focus optional when session persistence is unavailable', () => {
    const { port, scheduled } = authority(false);
    vi.mocked(port.persistProviderFocus).mockImplementation(() => {
      throw new Error('private storage detail');
    });
    expect(openProviderConnectionEntrypoint('openai', port)).toEqual({ ok: true });
    expect(port.setSettingsOpen).toHaveBeenCalledWith(true);
    scheduled[0]!();
    expect(port.emitProviderFocus).toHaveBeenCalledWith('openai');
  });
});
