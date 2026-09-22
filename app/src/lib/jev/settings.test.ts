import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureJevSettingsBridge,
  getJevLocalUsage,
  loadJevSettings,
  removeJevApiKey,
  saveJevApiKey,
  setJevModel,
  testJevConnection,
} from './settings';

const mocks = vi.hoisted(() => {
  const settings = new Map<string, { key: string; value: unknown; updated_at: number }>();
  const usageRows: Array<Record<string, unknown>> = [];
  const db = {
    settings: {
      get: vi.fn(async (key: string) => settings.get(key)),
      put: vi.fn(async (row: { key: string; value: unknown; updated_at: number }) => {
        settings.set(row.key, row);
      }),
      toArray: vi.fn(async () => [...settings.values()]),
      bulkDelete: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => settings.delete(key));
      }),
    },
    jev_usage_records: {
      where: vi.fn((index: string) => ({
        equals: vi.fn((scope: readonly string[]) => ({
          toArray: vi.fn(async () =>
            index === '[accountId+workspaceId]'
              ? usageRows.filter(
                  (row) => row.accountId === scope[0] && row.workspaceId === scope[1],
                )
              : [],
          ),
        })),
      })),
    },
  };
  (db as { transaction?: unknown }).transaction = vi.fn(
    async (_mode: string, _table: unknown, callback: () => Promise<unknown>) => callback(),
  );
  return { db, settings, usageRows };
});

vi.mock('../db', () => ({ db: mocks.db }));

type BridgeOverrides = Partial<{
  loadJevSettings: unknown;
  testJevConnection: unknown;
}>;

function configureBridge(overrides: BridgeOverrides = {}) {
  const bridge = {
    loadJevSettings: vi
      .fn()
      .mockResolvedValue(
        overrides.loadJevSettings ?? { modelId: 'jev-latest', hasKey: true, connected: true },
      ),
    saveJevApiKey: vi.fn().mockResolvedValue(undefined),
    testJevConnection: vi.fn().mockResolvedValue(
      overrides.testJevConnection ?? {
        kind: 'connected',
        models: [{ id: 'jev-1.13.0' }],
        status: 200,
      },
    ),
    removeJevApiKey: vi.fn().mockResolvedValue(undefined),
  };
  configureJevSettingsBridge(bridge);
  return bridge;
}

const scopeA = { accountId: 'account-a', workspaceId: 'workspace-a' } as const;
const scopeB = { accountId: 'account-b', workspaceId: 'workspace-b' } as const;

describe('Jev secure settings bridge', () => {
  beforeEach(() => {
    mocks.settings.clear();
    mocks.usageRows.length = 0;
  });

  it('keeps saved credentials unverified until a scoped catalog test succeeds', async () => {
    const bridge = configureBridge();

    await saveJevApiKey('jev-private-key');
    expect(bridge.saveJevApiKey).toHaveBeenCalledWith('jev-private-key');
    await expect(loadJevSettings()).resolves.toEqual({
      modelId: 'jev-latest',
      hasKey: true,
      connected: false,
    });

    await setJevModel('jev-1.13.0', scopeA);
    await expect(loadJevSettings(scopeA)).resolves.toEqual({
      modelId: 'jev-1.13.0',
      hasKey: true,
      connected: false,
    });
    await expect(loadJevSettings(scopeB)).resolves.toEqual({
      modelId: 'jev-latest',
      hasKey: true,
      connected: false,
    });

    await expect(testJevConnection(scopeA)).resolves.toMatchObject({
      kind: 'connected',
      models: [{ id: 'jev-1.13.0' }],
    });
    const connected = await loadJevSettings(scopeA);
    expect(connected).toMatchObject({ modelId: 'jev-1.13.0', hasKey: true, connected: true });
    expect(connected.lastTestedAt).toEqual(expect.any(Number));
    expect(JSON.stringify([...mocks.settings.values()])).not.toContain('jev-private-key');
  });

  it('invalidates test metadata on model changes, failed tests, save, and remove', async () => {
    const bridge = configureBridge();

    await testJevConnection(scopeA);
    await expect(loadJevSettings(scopeA)).resolves.toMatchObject({ connected: true });

    bridge.testJevConnection.mockResolvedValue({ kind: 'invalid_key', models: [], status: 401 });
    await expect(testJevConnection(scopeA)).resolves.toMatchObject({ kind: 'invalid_key' });
    await expect(loadJevSettings(scopeA)).resolves.toMatchObject({
      modelId: 'jev-latest',
      connected: false,
    });

    bridge.testJevConnection.mockResolvedValue({
      kind: 'connected',
      models: [{ id: 'jev-latest' }],
      status: 200,
    });
    await testJevConnection(scopeA);
    await expect(loadJevSettings(scopeA)).resolves.toMatchObject({ connected: true });

    await setJevModel('jev-next', scopeA);
    await expect(loadJevSettings(scopeA)).resolves.toEqual({
      modelId: 'jev-next',
      hasKey: true,
      connected: false,
    });

    await saveJevApiKey('replacement-key');
    await expect(loadJevSettings(scopeA)).resolves.toMatchObject({
      modelId: 'jev-latest',
      connected: false,
    });
    expect(
      [...mocks.settings.keys()].filter((key) => key.startsWith('jev.settings.v1:')),
    ).toHaveLength(0);

    await removeJevApiKey();
    expect(bridge.removeJevApiKey).toHaveBeenCalledTimes(1);
    expect(
      [...mocks.settings.keys()].filter((key) => key.startsWith('jev.settings.v1:')),
    ).toHaveLength(0);
  });

  it('reads bounded local usage records for the requested account/workspace only', async () => {
    configureBridge();
    mocks.usageRows.push(
      {
        recordedAt: 100,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-1',
        inputTokens: 12,
        outputTokens: 4,
        costUsd: null,
        costProvenance: 'unavailable',
        status: 'ok',
      },
      {
        recordedAt: 200,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-2',
        inputTokens: 8,
        outputTokens: 2,
        costUsd: 0.5,
        costProvenance: 'provider-reported',
        status: 'ok',
      },
      {
        recordedAt: 300,
        accountId: scopeB.accountId,
        workspaceId: scopeB.workspaceId,
        model: 'jev-other',
        inputTokens: 99,
        outputTokens: 99,
        costUsd: 9,
        costProvenance: 'estimated',
        status: 'ok',
      },
      {
        recordedAt: 400,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-invalid',
        inputTokens: -1,
        outputTokens: 1,
        costUsd: -2,
        costProvenance: 'estimated',
        status: 'ok',
      },
    );

    await expect(getJevLocalUsage(scopeA)).resolves.toEqual([
      {
        recordedAt: 400,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-invalid',
        inputTokens: null,
        outputTokens: 1,
        costUsd: null,
        costProvenance: 'estimated',
        status: 'ok',
      },
      {
        recordedAt: 200,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-2',
        inputTokens: 8,
        outputTokens: 2,
        costUsd: 0.5,
        costProvenance: 'provider-reported',
        status: 'ok',
      },
      {
        recordedAt: 100,
        accountId: scopeA.accountId,
        workspaceId: scopeA.workspaceId,
        model: 'jev-1',
        inputTokens: 12,
        outputTokens: 4,
        costUsd: null,
        costProvenance: 'unavailable',
        status: 'ok',
      },
    ]);
    await expect(getJevLocalUsage()).rejects.toThrow('jev_scope_unavailable');
  });

  it('rejects unsafe model or scope inputs before persistence', async () => {
    const bridge = configureBridge();
    await expect(setJevModel('')).rejects.toThrow('jev_model_invalid');
    await expect(setJevModel('x'.repeat(129), scopeA)).rejects.toThrow('jev_model_invalid');
    await expect(setJevModel('jev-1')).rejects.toThrow('jev_scope_unavailable');
    await expect(
      setJevModel('jev-1', { accountId: '', workspaceId: 'workspace-a' }),
    ).rejects.toThrow('jev_scope_invalid');
    expect(bridge.saveJevApiKey).not.toHaveBeenCalled();
  });

  it('does not stamp an old catalog result after a concurrent credential save', async () => {
    const bridge = configureBridge();
    let resolveTest: ((value: unknown) => void) | undefined;
    bridge.testJevConnection.mockReturnValue(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );

    const pending = testJevConnection(scopeA);
    await vi.waitFor(() => expect(bridge.testJevConnection).toHaveBeenCalledTimes(1));
    await saveJevApiKey('new-key');
    resolveTest?.({ kind: 'connected', models: [{ id: 'jev-latest' }], status: 200 });
    await pending;

    await expect(loadJevSettings(scopeA)).resolves.toMatchObject({ connected: false });
    expect(
      [...mocks.settings.keys()].filter((key) => key.startsWith('jev.settings.v1:')),
    ).toHaveLength(0);
  });
});
