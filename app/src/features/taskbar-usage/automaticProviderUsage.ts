import type { ProviderConnection } from '@/lib/ai/adapters/types';
import type { ConnectionMetadata } from '@/lib/ai/connectionState';
import type { LocalUsageTotals } from '@/lib/usage/usageSummary';
import type { ProviderActivitySnapshot } from './activityTracker';
import type { ProviderUsageSnapshot } from './providerUsageTypes';
import { PROVIDER_USAGE_DEFINITIONS } from './providerUsageRegistry';

export function buildAutomaticProviderSnapshots(input: {
  connections: readonly Readonly<ProviderConnection>[];
  connectedProviderIds: readonly string[];
  connectionMetadata: ConnectionMetadata;
  connectionUsage: Partial<Record<string, LocalUsageTotals>>;
  activity: ProviderActivitySnapshot;
  now: number;
}): ProviderUsageSnapshot[] {
  const connectedProviders = new Set(input.connectedProviderIds);
  const snapshots: ProviderUsageSnapshot[] = [];
  for (const connection of input.connections) {
    if (!connection.enabled) continue;
    const external = connection.mode === 'external-cli';
    const localRuntime = connection.mode === 'local';
    const definition = PROVIDER_USAGE_DEFINITIONS.find(({ id }) => id === connection.providerId);
    const metadata = input.connectionMetadata[connection.id];
    const connected = external
      ? metadata?.installation === 'installed' &&
        metadata.disabled !== true &&
        metadata.auth !== 'unauthenticated'
      : connectedProviders.has(connection.providerId);
    if (!connected) continue;

    const local = input.connectionUsage[connection.id];
    const hasExactLedger = (local?.calls ?? 0) > 0;
    const locallyRecordedTokens = local
      ? local.totalTokens ?? local.inputTokens + local.outputTokens
      : 0;
    const activeRequests =
      input.activity.byProvider[connection.id] ??
      input.activity.byProvider[connection.providerId] ??
      0;
    snapshots.push({
      providerId: connection.id,
      providerFamilyId: connection.providerId,
      displayName: connection.displayName,
      connected: true,
      connectionState: 'connected',
      routeId: connection.id,
      ...(connection.modelId ? { modelId: connection.modelId } : {}),
      routeLabel: external ? 'CLI bridge' : localRuntime ? 'Local runtime' : 'API key',
      routeType: external ? 'cli_bridge' : localRuntime ? 'local_runtime' : 'api_key',
      usageCapability: definition?.usageCapability ?? 'estimate_only',
      hidden: false,
      activeRequests,
      usageValue: hasExactLedger ? locallyRecordedTokens : null,
      usageLimit: null,
      usageUnit: hasExactLedger ? 'tokens' : null,
      usagePercent: null,
      localUsageValue: hasExactLedger ? locallyRecordedTokens : null,
      localUsageUnit: hasExactLedger ? 'tokens' : null,
      reconciliation: 'not_comparable',
      requestsPerMinute: null,
      updatedAt: local?.lastUsed ?? 0,
      freshness:
        activeRequests > 0
          ? 'live'
          : !hasExactLedger
            ? 'expired'
            : input.now - (local?.lastUsed ?? 0) >= 120_000
              ? 'stale'
              : 'fresh',
      source: !hasExactLedger
        ? 'unavailable'
        : external
          ? 'terminal-session'
          : localRuntime
            ? 'local-runtime'
            : 'local-events',
    });
  }
  return snapshots;
}
