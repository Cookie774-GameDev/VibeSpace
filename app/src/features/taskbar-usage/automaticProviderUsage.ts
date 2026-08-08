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
  localUsage: Partial<Record<string, LocalUsageTotals>>;
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

    // Provider-level response metadata cannot safely distinguish a CLI session
    // from a native API connection in the same family. Attribute it only to
    // the native connection; CLI quota remains explicitly unavailable.
    const local = external ? undefined : input.localUsage[connection.providerId];
    const locallyRecordedTokens = local
      ? local.inputTokens + local.outputTokens + local.cachedTokens
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
      routeLabel: external ? 'CLI bridge' : localRuntime ? 'Local runtime' : 'API key',
      routeType: external ? 'cli_bridge' : localRuntime ? 'local_runtime' : 'api_key',
      usageCapability: definition?.usageCapability ?? 'estimate_only',
      hidden: false,
      activeRequests,
      usageValue: locallyRecordedTokens > 0 ? locallyRecordedTokens : null,
      usageLimit: null,
      usageUnit: locallyRecordedTokens > 0 ? 'tokens' : null,
      usagePercent: null,
      localUsageValue: locallyRecordedTokens > 0 ? locallyRecordedTokens : null,
      localUsageUnit: locallyRecordedTokens > 0 ? 'tokens' : null,
      reconciliation: 'not_comparable',
      requestsPerMinute: null,
      updatedAt: local?.lastUsed ?? input.now,
      freshness: activeRequests > 0 ? 'live' : 'fresh',
      source: external ? 'terminal-session' : localRuntime ? 'local-runtime' : 'local-events',
    });
  }
  return snapshots;
}
