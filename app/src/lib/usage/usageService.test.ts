import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import { OLLAMA_LOCAL_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import { readCodexAccountUsage } from '@/lib/ai/adapters/codexAccountUsage';
import {
  recordConnectionUsage,
  resetConnectionUsageLedgerForTests,
} from '@/lib/ai/connectionUsageLedger';
import { messageRepo } from '@/lib/db/repositories';
import {
  getAllUsage,
  getUsage,
  parseUsageSlashCommand,
  refreshUsage,
  resolveUsageConnection,
  supportsCodexAccountUsage,
} from './usageService';

vi.mock('@/lib/db/repositories', () => ({
  messageRepo: { listByChat: vi.fn() },
}));

vi.mock('@/lib/ai/adapters/codexAccountUsage', () => ({
  readCodexAccountUsage: vi.fn(),
}));

describe('truthful usage service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConnectionUsageLedgerForTests();
  });

  it('aggregates only current-chat response metadata and never invents quota zero', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([
      {
        id: 'm1',
        chat_id: 'chat-1',
        role: 'assistant',
        parts: [],
        created_at: 1,
        updated_at: 1,
        usage: {
          provider: 'openai',
          model: 'gpt-5.4',
          input_tokens: 8,
          output_tokens: 3,
        },
      },
      {
        id: 'm2',
        chat_id: 'chat-1',
        role: 'assistant',
        parts: [],
        created_at: 2,
        updated_at: 2,
        usage: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          input_tokens: 999,
          output_tokens: 999,
        },
      },
    ] as never);
    const usage = await getUsage(
      { ...CODEX_CLI_CONNECTION, modelId: 'gpt-5.4' },
      'chat-1' as never,
      'default',
    );
    expect(messageRepo.listByChat).toHaveBeenCalledWith('chat-1');
    expect(usage.currentChat.totalTokens).toMatchObject({ value: 11, provenance: 'local-exact' });
    expect(usage.usageMode).toBe('default');
    expect(usage.routeWindow).toBeUndefined();
    expect(usage.accountUsageState).toBeUndefined();
    expect(usage.quota.value).toBeUndefined();
    expect(usage.quota.provenance).toBe('unavailable');
  });

  it('labels local runtime as having no subscription quota', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    const usage = await getUsage(OLLAMA_LOCAL_CONNECTION, 'chat-2' as never);
    expect(usage.quota).toMatchObject({
      provenance: 'unavailable',
      reason: 'No subscription quota.',
    });
    expect(usage.currentChat.requests.value).toBeUndefined();
  });

  it('uses a provider-reported total without adding its cached-input subset', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([
      {
        id: 'm-opencode',
        chat_id: 'chat-opencode',
        role: 'assistant',
        parts: [],
        created_at: 1,
        updated_at: 1,
        usage: {
          provider: 'openai',
          model: 'openai/gpt-5.6-luna',
          input_tokens: 33_264,
          output_tokens: 381,
          cache_read_tokens: 65_280,
          total_tokens: 98_925,
        },
      },
    ] as never);

    const usage = await getUsage(
      { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.6-luna' },
      'chat-opencode' as never,
    );

    expect(usage.currentChat).toMatchObject({
      inputTokens: { value: 33_264 },
      cachedInputTokens: { value: 65_280 },
      outputTokens: { value: 381 },
      totalTokens: { value: 98_925, provenance: 'response-metadata' },
    });
  });

  it('loads the chat once for an all-connection summary', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    const usage = await getAllUsage(
      [CODEX_CLI_CONNECTION, OLLAMA_LOCAL_CONNECTION],
      'chat-3' as never,
    );
    expect(usage).toHaveLength(2);
    expect(messageRepo.listByChat).toHaveBeenCalledOnce();
    expect(usage.every((snapshot) => snapshot.usageMode === 'all')).toBe(true);
    expect(usage.every((snapshot) => snapshot.routeWindow)).toBe(true);
    expect(usage.every((snapshot) => snapshot.routeWindow?.label === 'Rolling 30 days')).toBe(true);
    expect(usage.every((snapshot) => snapshot.currentChat.requests.value === undefined)).toBe(true);
  });

  it('uses the exact connection and model ledger for session mode, including recorded zero cost', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    const connection = { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.6-luna' };
    recordConnectionUsage({
      connectionId: connection.id,
      providerId: 'openai',
      modelId: connection.modelId,
      timestamp: Date.now(),
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      costUsd: 0,
    });
    recordConnectionUsage({
      connectionId: connection.id,
      providerId: 'deepseek',
      modelId: 'deepseek/deepseek-v4-flash',
      timestamp: Date.now(),
      inputTokens: 999,
      cachedInputTokens: 0,
      outputTokens: 999,
      costUsd: 9,
    });

    const usage = await getUsage(connection, 'chat-session' as never, 'session');
    expect(usage.routeWindow).toMatchObject({
      label: 'Current app session',
      availability: 'available',
      models: ['openai/gpt-5.6-luna'],
      totalTokens: { value: 14, provenance: 'local-exact' },
      costUsd: { value: 0, provenance: 'local-exact' },
      requests: { value: 1, provenance: 'local-exact' },
    });
    expect(usage.note).toMatch(/bridge-local/i);
  });

  it('refreshes the supported exact OpenCode upstream route without merging account and ledger provenance', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    vi.mocked(readCodexAccountUsage).mockResolvedValue({
      windows: [
        {
          label: '5h',
          usedPercent: 25,
          remainingPercent: 75,
          windowDurationMins: 300,
          resetsAt: 123,
        },
      ],
      creditsRemaining: null,
      planType: 'plus',
      tokens: 900,
      updatedAt: Date.now(),
      source: 'codex-app-server',
      freshness: 'live',
      availability: 'available',
    });
    const connection = { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.6-sol' };

    const usage = await refreshUsage(connection, 'chat-refresh' as never);
    expect(usage).toMatchObject({
      connectionId: 'opencode-cli',
      modelId: 'openai/gpt-5.6-sol',
      usageMode: 'refresh',
      providerPeriod: { value: 900, provenance: 'provider-cli' },
      quota: { value: 25, provenance: 'provider-cli' },
      accountUsageState: 'available',
      routeWindow: { label: 'Rolling 30 days' },
    });
    expect(usage.routeWindow?.requests.value).toBeUndefined();
    expect(supportsCodexAccountUsage(connection)).toBe(true);
    expect(
      supportsCodexAccountUsage({
        ...OPENCODE_CLI_CONNECTION,
        modelId: 'deepseek/deepseek-v4-flash',
      }),
    ).toBe(false);
  });

  it('retains exact route usage and exposes a Codex account refresh error', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    vi.mocked(readCodexAccountUsage).mockRejectedValue(new Error('native unavailable'));
    const connection = { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.6-luna' };
    recordConnectionUsage({
      connectionId: connection.id,
      providerId: 'openai',
      modelId: connection.modelId,
      timestamp: Date.now(),
      inputTokens: 4,
      cachedInputTokens: 0,
      outputTokens: 2,
      costUsd: 0,
    });

    const usage = await refreshUsage(connection, 'chat-refresh-error' as never);
    expect(usage).toMatchObject({
      accountUsageState: 'error',
      errorCode: 'CODEX_ACCOUNT_USAGE_UNAVAILABLE',
      routeWindow: {
        availability: 'available',
        totalTokens: { value: 6, provenance: 'local-exact' },
      },
    });
    expect(usage.providerPeriod.value).toBeUndefined();
  });

  it('labels an old supported account snapshot stale instead of freshly live', async () => {
    vi.mocked(messageRepo.listByChat).mockResolvedValue([]);
    vi.mocked(readCodexAccountUsage).mockResolvedValue({
      windows: [
        {
          label: '5h',
          usedPercent: 10,
          remainingPercent: 90,
          windowDurationMins: 300,
          resetsAt: null,
        },
      ],
      creditsRemaining: null,
      planType: 'plus',
      tokens: null,
      updatedAt: 1,
      source: 'codex-app-server',
      freshness: 'live',
      availability: 'available',
    });

    const usage = await refreshUsage(
      { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.4' },
      'chat-refresh-stale' as never,
    );
    expect(usage).toMatchObject({
      availability: 'stale',
      accountUsageState: 'stale',
      quota: { value: 10, provenance: 'provider-cli' },
      routeWindow: { availability: 'unavailable' },
    });
  });

  it('preserves the persisted connection and exact upstream model over transient selection state', () => {
    const persisted = { ...OPENCODE_CLI_CONNECTION, modelId: 'openai/gpt-5.6-luna' };
    expect(
      resolveUsageConnection({
        persistedConnection: persisted,
        selectedConnectionId: 'openai-codex',
        selectedModelId: 'gpt-5.6-sol',
        connections: [OPENCODE_CLI_CONNECTION, CODEX_CLI_CONNECTION],
      }),
    ).toEqual(persisted);
  });

  it.each([
    ['/usage', 'default'],
    ['/usage refresh', 'refresh'],
    ['/usage session', 'session'],
    ['/usage all', 'all'],
  ])('intercepts %s as %s', (command, mode) => {
    expect(parseUsageSlashCommand(command)).toBe(mode);
  });
});
