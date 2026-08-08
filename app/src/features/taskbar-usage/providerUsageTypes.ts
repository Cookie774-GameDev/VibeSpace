export type ProviderUsageUnit = 'requests' | 'tokens' | 'credits' | 'usd' | 'percent' | null;

export type ProviderUsageFreshness = 'live' | 'fresh' | 'stale' | 'expired' | 'offline' | 'error';

export type ProviderConnectionState =
  | 'disconnected'
  | 'detecting'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'permission_required'
  | 'unsupported'
  | 'error';

export type ProviderConnectionRouteType =
  | 'api_key'
  | 'oauth'
  | 'cli_bridge'
  | 'local_runtime'
  | 'cloud_credential';

export type ProviderUsageCapability = 'supported' | 'partial' | 'estimate_only' | 'unsupported';
export type ProviderUsageReconciliation =
  | 'matched'
  | 'provider_ahead'
  | 'local_ahead'
  | 'not_comparable';

export type ProviderUsageCategory = 'llm' | 'speech' | 'image' | 'embedding' | 'platform';
export type ProviderUsageRegistrySort = 'active' | 'warning' | 'usage' | 'name' | 'recent';

export interface ProviderUsageRouteDefinition {
  id: string;
  label: string;
  type: ProviderConnectionRouteType;
}

export interface ProviderUsageDefinition {
  id: string;
  displayName: string;
  category: ProviderUsageCategory;
  routes: readonly ProviderUsageRouteDefinition[];
  usageCapability: ProviderUsageCapability;
  iconLabel?: string;
  billingUrl?: string;
}

export interface ProviderUsageSnapshot {
  providerId: string;
  providerFamilyId?: string;
  displayName: string;
  connected: boolean;
  connectionState?: ProviderConnectionState;
  routeId?: string;
  routeLabel?: string;
  routeType?: ProviderConnectionRouteType;
  usageCapability?: ProviderUsageCapability;
  planScope?: string;
  hidden: boolean;
  activeRequests: number;
  usageValue: number | null;
  usageLimit: number | null;
  usageUnit: ProviderUsageUnit;
  usagePercent: number | null;
  localUsageValue?: number | null;
  localUsageUnit?: ProviderUsageUnit;
  reconciliation?: ProviderUsageReconciliation;
  requestsPerMinute: number | null;
  updatedAt: number;
  lastAttemptAt?: number;
  resetAt?: number | null;
  retryAt?: number | null;
  rateLimitState?: 'clear' | 'limited' | 'unknown';
  freshness: ProviderUsageFreshness;
  source:
    | 'local-events'
    | 'provider-api'
    | 'terminal-session'
    | 'oauth-session'
    | 'local-runtime'
    | 'estimate'
    | 'cached'
    | 'unavailable';
  errorCode?: string;
}

export interface ProviderUsageAdapter {
  id: string;
  detect(): Promise<boolean>;
  getCachedSnapshot(): ProviderUsageSnapshot | null;
  refreshQuota(signal: AbortSignal): Promise<ProviderUsageSnapshot>;
  subscribeToActivity(listener: (snapshot: ProviderUsageSnapshot) => void): () => void;
}

export type TaskbarEdge = 'top' | 'right' | 'bottom' | 'left';

export interface TaskbarUsagePlacement {
  monitorName: string;
  edge: TaskbarEdge;
  offset: number;
}

export interface TaskbarUsagePreferences {
  enabled: boolean;
  launchWithVibeSpace: boolean;
  providerOrder: string[];
  hiddenProviderIds: string[];
  pinnedProviderIds: string[];
  registrySort: ProviderUsageRegistrySort;
  detailsOpen: boolean;
  placement: TaskbarUsagePlacement | null;
  collapsed: boolean;
}

export interface TaskbarUsagePayload {
  snapshots: ProviderUsageSnapshot[];
  totalActiveRequests: number;
  publishedAt: number;
}

export interface TaskbarUsageRuntimeDiagnostic {
  code: 'WINDOW_CREATE_FAILED' | 'WINDOW_SHOW_FAILED';
  message: string;
  occurredAt: number;
  retryable: true;
}
