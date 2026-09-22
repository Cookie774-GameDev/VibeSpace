import type { ChatId } from '@/types/common';
import type { Message } from '@/types/chat';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { readCodexAccountUsage } from '@/lib/ai/adapters/codexAccountUsage';
import {
  aggregateConnectionUsage,
  CONNECTION_USAGE_SESSION_STARTED_AT,
  type ConnectionUsageWindow,
} from '@/lib/ai/connectionUsageLedger';
import { messageRepo } from '@/lib/db/repositories';
import type {
  RouteUsageWindow,
  UsageAvailability,
  UsageMode,
  UsageSnapshot,
  UsageTotals,
  UsageValue,
} from './usageTypes';

export const ROUTE_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const REFRESH_TTL_MS = 30_000;
const CODEX_ACCOUNT_STALE_MS = 120_000;

const unavailable = (unit: UsageValue['unit'], reason: string): UsageValue => ({
  unit,
  provenance: 'unavailable',
  reason,
});

function exactSum(
  messages: readonly Message[],
  pick: (message: Message) => number | undefined,
  unit: UsageValue['unit'],
): UsageValue {
  const values = messages
    .map(pick)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0
    ? {
        value: values.reduce((sum, value) => sum + value, 0),
        unit,
        provenance: 'response-metadata',
      }
    : unavailable(unit, 'Not reported by responses in this chat.');
}

function totalSum(messages: readonly Message[]): UsageValue {
  const values = messages
    .map((message) => {
      const reportedTotal = message.usage?.total_tokens;
      if (
        typeof reportedTotal === 'number' &&
        Number.isSafeInteger(reportedTotal) &&
        reportedTotal >= 0
      ) {
        return { value: reportedTotal, reported: true };
      }
      const input = message.usage?.input_tokens;
      const output = message.usage?.output_tokens;
      if (
        typeof input === 'number' &&
        Number.isFinite(input) &&
        input >= 0 &&
        typeof output === 'number' &&
        Number.isFinite(output) &&
        output >= 0
      ) {
        return { value: input + output, reported: false };
      }
      return undefined;
    })
    .filter((value): value is { value: number; reported: boolean } => value !== undefined);
  if (values.length === 0) {
    return unavailable('tokens', 'No total token count is reported by responses.');
  }
  return {
    value: values.reduce((sum, value) => sum + value.value, 0),
    unit: 'tokens',
    provenance: values.every((value) => value.reported) ? 'response-metadata' : 'local-exact',
  };
}

function unavailableTotals(reason: string): UsageTotals {
  return {
    inputTokens: unavailable('tokens', reason),
    cachedInputTokens: unavailable('tokens', reason),
    outputTokens: unavailable('tokens', reason),
    totalTokens: unavailable('tokens', reason),
    costUsd: unavailable('usd', reason),
    requests: unavailable('requests', reason),
  };
}

function expectedUsageProvider(connection: Readonly<ProviderConnection>): string | undefined {
  if (connection.id === 'opencode-cli' && connection.modelId?.includes('/')) {
    return connection.modelId.slice(0, connection.modelId.indexOf('/'));
  }
  return connection.mode === 'local' && connection.providerId === 'local'
    ? 'ollama'
    : connection.providerId;
}

function currentChatTotals(
  connection: Readonly<ProviderConnection>,
  messages: readonly Message[],
): UsageTotals {
  const expectedProvider = expectedUsageProvider(connection);
  const expectedModel = connection.modelId?.trim();
  if (!expectedProvider || !expectedModel) {
    return unavailableTotals(
      'The selected route has no exact provider and model identity for current-chat attribution.',
    );
  }
  const scoped = messages.filter(
    (message) =>
      message.usage?.provider === expectedProvider && message.usage.model === expectedModel,
  );
  if (scoped.length === 0) {
    return unavailableTotals(
      'No response in this chat has matching provider and model evidence for this route.',
    );
  }
  const inputTokens = exactSum(scoped, (message) => message.usage?.input_tokens, 'tokens');
  const cachedInputTokens = exactSum(
    scoped,
    (message) => (message.usage?.cache_read_tokens ?? 0) + (message.usage?.cache_write_tokens ?? 0),
    'tokens',
  );
  const outputTokens = exactSum(scoped, (message) => message.usage?.output_tokens, 'tokens');
  const totalTokens = totalSum(scoped);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    costUsd: exactSum(scoped, (message) => message.usage?.cost_usd, 'usd'),
    requests:
      scoped.length > 0
        ? { value: scoped.length, unit: 'requests', provenance: 'local-exact' }
        : unavailable('requests', 'No metered responses are stored in this chat.'),
  };
}

function routeWindowValue(
  value: number,
  unit: UsageValue['unit'],
  available: boolean,
  reason: string,
): UsageValue {
  return available ? { value, unit, provenance: 'local-exact' } : unavailable(unit, reason);
}

export function summarizeRouteUsageWindow(
  connection: Readonly<ProviderConnection>,
  since: number,
  label: RouteUsageWindow['label'] = 'Rolling 30 days',
): RouteUsageWindow {
  const ledger = aggregateConnectionUsage(connection.id, since, connection.modelId);
  return routeWindowFromLedger(ledger, label);
}

function routeWindowFromLedger(
  ledger: Readonly<ConnectionUsageWindow>,
  label: RouteUsageWindow['label'],
): RouteUsageWindow {
  const available = ledger.availability === 'available';
  const reason = 'No exact requests are recorded for this connection and model in this window.';
  return {
    label,
    inputTokens: routeWindowValue(ledger.inputTokens, 'tokens', available, reason),
    cachedInputTokens: routeWindowValue(ledger.cachedInputTokens, 'tokens', available, reason),
    outputTokens: routeWindowValue(ledger.outputTokens, 'tokens', available, reason),
    totalTokens: routeWindowValue(
      ledger.totalTokens,
      'tokens',
      available,
      reason,
    ),
    costUsd: routeWindowValue(ledger.costUsd, 'usd', available, reason),
    requests: routeWindowValue(ledger.requests, 'requests', available, reason),
    startedAt: ledger.startedAt,
    lastRequestAt: ledger.lastRequestAt,
    models: ledger.models,
    availability: ledger.availability,
  };
}

function baseNote(connection: Readonly<ProviderConnection>): string | undefined {
  return connection.id === 'opencode-cli'
    ? 'OpenCode usage is bridge-local. Upstream account usage is shown separately only for an exact supported route.'
    : undefined;
}

export function supportsCodexAccountUsage(connection: Readonly<ProviderConnection>): boolean {
  if (connection.id === 'openai-codex') return true;
  return (
    connection.id === 'opencode-cli' &&
    connection.mode === 'external-cli' &&
    connection.modelId?.toLocaleLowerCase('en-US').startsWith('openai/') === true
  );
}

function snapshotAvailability(
  currentChat: UsageTotals,
  routeWindow: RouteUsageWindow | undefined,
): UsageAvailability {
  if (currentChat.requests.value !== undefined || routeWindow?.availability === 'available') {
    return 'available';
  }
  return 'unavailable';
}

export function summarizeCurrentChatUsage(
  connection: Readonly<ProviderConnection>,
  messages: readonly Message[],
  mode: UsageMode = 'default',
  now = Date.now(),
): UsageSnapshot {
  const currentChat =
    mode === 'all'
      ? unavailableTotals(
          'Exact per-connection attribution is not stored on historical chat messages.',
        )
      : currentChatTotals(connection, messages);
  const routeWindow =
    mode === 'default'
      ? undefined
      : mode === 'session'
        ? summarizeRouteUsageWindow(
            connection,
            CONNECTION_USAGE_SESSION_STARTED_AT,
            'Current app session',
          )
        : summarizeRouteUsageWindow(connection, now - ROUTE_USAGE_WINDOW_MS, 'Rolling 30 days');
  const quotaReason =
    connection.mode === 'local'
      ? 'No subscription quota.'
      : 'No supported live account snapshot was requested for this route.';
  return {
    connectionId: connection.id,
    providerId: connection.providerId,
    providerName: connection.displayName,
    modelId: connection.modelId,
    mode: connection.mode,
    authSource: connection.authSource,
    capturedAt: now,
    usageMode: mode,
    availability: snapshotAvailability(currentChat, routeWindow),
    currentChat,
    ...(routeWindow ? { routeWindow } : {}),
    providerPeriod: unavailable(
      'tokens',
      'Provider-period usage was not returned by a supported live account surface.',
    ),
    quota: unavailable('percent', quotaReason),
    ...(baseNote(connection) ? { note: baseNote(connection) } : {}),
  };
}

async function withCodexAccountUsage(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
  try {
    const account = await readCodexAccountUsage();
    if (account.availability === 'unavailable') {
      return {
        ...snapshot,
        accountUsageState: 'unavailable',
        accountUsageUpdatedAt: account.updatedAt,
        note: [snapshot.note, account.unavailableReason].filter(Boolean).join(' '),
      };
    }
    const primary = account.windows[0];
    const accountUsageState =
      Date.now() - account.updatedAt >= CODEX_ACCOUNT_STALE_MS ? 'stale' : 'available';
    const providerPeriod =
      account.tokens !== null
        ? {
            value: account.tokens,
            unit: 'tokens' as const,
            provenance: 'provider-cli' as const,
          }
        : snapshot.providerPeriod;
    const quota = primary
      ? {
          value: primary.usedPercent,
          unit: 'percent' as const,
          provenance: 'provider-cli' as const,
          reason: `${primary.label}${primary.resetsAt ? ` · resets ${primary.resetsAt}` : ''}`,
        }
      : snapshot.quota;
    return {
      ...snapshot,
      availability:
        accountUsageState === 'stale' && snapshot.availability === 'unavailable'
          ? 'stale'
          : 'available',
      providerPeriod,
      quota,
      accountUsageState,
      accountUsageUpdatedAt: account.updatedAt,
      note: [
        snapshot.note,
        account.windows.length > 0
          ? `Codex account: ${account.windows
              .map((window) => `${window.label} ${window.usedPercent}%`)
              .join(' · ')}.`
          : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    };
  } catch {
    return {
      ...snapshot,
      accountUsageState: 'error',
      errorCode: 'CODEX_ACCOUNT_USAGE_UNAVAILABLE',
      note: [snapshot.note, 'Codex account usage refresh failed; route-ledger usage is retained.']
        .filter(Boolean)
        .join(' '),
    };
  }
}

export function parseUsageSlashCommand(input: string): UsageMode | undefined {
  const match = input.trim().match(/^\/usage(?:\s+(refresh|session|all))?$/i);
  return match ? ((match[1]?.toLowerCase() as UsageMode | undefined) ?? 'default') : undefined;
}

export function resolveUsageConnection(input: {
  persistedConnection?: Readonly<ProviderConnection>;
  selectedConnectionId?: string;
  selectedModelId?: string;
  fallbackProviderId?: string;
  fallbackModelId?: string;
  connections: readonly Readonly<ProviderConnection>[];
}): Readonly<ProviderConnection> | undefined {
  if (input.persistedConnection) return input.persistedConnection;
  const selected = input.selectedConnectionId
    ? input.connections.find((connection) => connection.id === input.selectedConnectionId)
    : undefined;
  if (selected) {
    return input.selectedModelId ? { ...selected, modelId: input.selectedModelId } : selected;
  }
  const fallback = input.connections.find(
    (connection) =>
      connection.providerId === input.fallbackProviderId &&
      (input.fallbackProviderId === 'ollama' || input.fallbackProviderId === 'local'
        ? connection.mode === 'local'
        : connection.mode === 'native-api'),
  );
  return fallback && input.fallbackModelId
    ? { ...fallback, modelId: input.fallbackModelId }
    : fallback;
}

export async function getUsage(
  connection: Readonly<ProviderConnection>,
  chatId: ChatId,
  mode: UsageMode = 'default',
): Promise<UsageSnapshot> {
  const snapshot = summarizeCurrentChatUsage(
    connection,
    await messageRepo.listByChat(chatId),
    mode,
  );
  return mode === 'refresh' && supportsCodexAccountUsage(connection)
    ? withCodexAccountUsage(snapshot)
    : snapshot;
}

export async function getAllUsage(
  connections: readonly Readonly<ProviderConnection>[],
  chatId: ChatId,
): Promise<UsageSnapshot[]> {
  const messages = await messageRepo.listByChat(chatId);
  return connections
    .filter((connection) => connection.enabled)
    .map((connection) => summarizeCurrentChatUsage(connection, messages, 'all'));
}

const refreshFlights = new Map<string, Promise<UsageSnapshot>>();
const refreshCache = new Map<string, { expiresAt: number; value: UsageSnapshot }>();

export async function refreshUsage(
  connection: Readonly<ProviderConnection>,
  chatId: ChatId,
): Promise<UsageSnapshot> {
  const key = `${connection.id}:${connection.modelId ?? 'model-unset'}:${chatId}`;
  const cached = refreshCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = refreshFlights.get(key);
  if (existing) return existing;
  const flight = getUsage(connection, chatId, 'refresh')
    .then((value) => {
      if (!supportsCodexAccountUsage(connection) || value.accountUsageState === 'available') {
        refreshCache.set(key, { expiresAt: Date.now() + REFRESH_TTL_MS, value });
      }
      return value;
    })
    .finally(() => refreshFlights.delete(key));
  refreshFlights.set(key, flight);
  return flight;
}
