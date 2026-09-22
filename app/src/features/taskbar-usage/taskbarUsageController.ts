import { PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import { ensureExternalConnectionAutoDetection } from '@/lib/ai/adapters/autoDetectConnections';
import { readConnectionMetadata } from '@/lib/ai/connectionState';
import { getConnectedProviders } from '@/lib/ai/providerRegistry';
import { useAuthStore } from '@/stores/auth';
import { providerActivityTracker } from './activityTracker';
import { buildAutomaticProviderSnapshots } from './automaticProviderUsage';
import { taskbarUsageStore } from './taskbarUsageStore';
import {
  ensureTaskbarUsageWindow,
  hideTaskbarUsageWindow,
  showMainWindowConnections,
} from './taskbarUsageNativeWindow';
import type { ProviderUsageSnapshot } from './providerUsageTypes';
import { createUsageRefreshCoordinator } from './usageRefreshCoordinator';
import { aggregateConnectionUsage } from '@/lib/ai/connectionUsageLedger';
import {
  readCodexAccountUsage,
  type CodexAccountUsageSnapshot,
} from '@/lib/ai/adapters/codexAccountUsage';
import { supportsCodexAccountUsage } from '@/lib/usage/usageService';
import {
  BACKGROUND_PROVIDER_REFRESH_MS,
  DISPLAY_REFRESH_MS,
  FOREGROUND_PROVIDER_REFRESH_MS,
} from './usageRefreshPolicy';

export {
  BACKGROUND_PROVIDER_REFRESH_MS,
  DISPLAY_REFRESH_MS,
  FOREGROUND_PROVIDER_REFRESH_MS,
} from './usageRefreshPolicy';

let stopController: (() => void) | undefined;
const ACCOUNT_USAGE_STALE_MS = 120_000;

function eligibleAccountRouteIds(
  connections: readonly Readonly<(typeof PROVIDER_CONNECTIONS)[number]>[],
): Set<string> {
  return new Set(connections.filter(supportsCodexAccountUsage).map((connection) => connection.id));
}

export function mergeCodexAccountUsageSnapshots(
  snapshots: readonly ProviderUsageSnapshot[],
  connections: readonly Readonly<(typeof PROVIDER_CONNECTIONS)[number]>[],
  account: Readonly<CodexAccountUsageSnapshot>,
  now = Date.now(),
): ProviderUsageSnapshot[] {
  const eligible = eligibleAccountRouteIds(connections);
  return snapshots.map((snapshot) => {
    if (!snapshot.routeId || !eligible.has(snapshot.routeId)) return snapshot;
    if (account.availability === 'unavailable') {
      return {
        ...snapshot,
        accountUsageState: 'unavailable',
        accountUsageUpdatedAt: account.updatedAt,
      };
    }
    const primary = account.windows[0];
    const accountUsageState =
      now - account.updatedAt >= ACCOUNT_USAGE_STALE_MS ? ('stale' as const) : ('live' as const);
    const accountMetric = primary
      ? {
          usageValue: primary.usedPercent,
          usageLimit: 100,
          usageUnit: 'percent' as const,
          usagePercent: primary.usedPercent,
          resetAt: primary.resetsAt,
        }
      : account.tokens !== null
        ? {
            usageValue: account.tokens,
            usageLimit: null,
            usageUnit: 'tokens' as const,
            usagePercent: null,
          }
        : {};
    return {
      ...snapshot,
      ...accountMetric,
      planScope: [
        account.planType,
        account.windows.map((window) => `${window.label} ${window.usedPercent}%`).join(' · '),
        account.creditsRemaining === null ? null : `${account.creditsRemaining} credits`,
      ]
        .filter(Boolean)
        .join(' · '),
      source: Object.keys(accountMetric).length > 0 ? 'provider-api' : snapshot.source,
      updatedAt: Object.keys(accountMetric).length > 0 ? account.updatedAt : snapshot.updatedAt,
      freshness:
        Object.keys(accountMetric).length > 0
          ? accountUsageState === 'stale'
            ? 'stale'
            : 'fresh'
          : snapshot.freshness,
      accountUsageState,
      accountUsageUpdatedAt: account.updatedAt,
    };
  });
}

export function markCodexAccountUsageError(
  snapshots: readonly ProviderUsageSnapshot[],
  connections: readonly Readonly<(typeof PROVIDER_CONNECTIONS)[number]>[],
): ProviderUsageSnapshot[] {
  const eligible = eligibleAccountRouteIds(connections);
  return snapshots.map((snapshot) =>
    snapshot.routeId !== undefined && eligible.has(snapshot.routeId)
      ? {
          ...snapshot,
          accountUsageState: 'error',
          errorCode: 'CODEX_ACCOUNT_USAGE_UNAVAILABLE',
        }
      : snapshot,
  );
}

export function createAsyncUnlistenerRegistry() {
  let stopped = false;
  const unlisteners = new Set<() => void>();
  return {
    add(unlisten: () => void): void {
      if (stopped) {
        unlisten();
        return;
      }
      unlisteners.add(unlisten);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const unlisten of unlisteners) unlisten();
      unlisteners.clear();
    },
  };
}

export function startTaskbarUsageController(): () => void {
  if (stopController) return stopController;

  let snapshots: ProviderUsageSnapshot[] = [];
  let stopped = false;
  let displayTimer: number | undefined;
  let mainVisible = true;
  let lastPreferencesKey = '';
  const nativeUnlisteners = createAsyncUnlistenerRegistry();
  const refreshCoordinator = createUsageRefreshCoordinator();
  refreshCoordinator.setOnline(globalThis.navigator?.onLine !== false);

  const publish = () => {
    const activity = providerActivityTracker.snapshot();
    const withLiveActivity = snapshots.map((snapshot) => {
      const providerId =
        PROVIDER_CONNECTIONS.find(({ id }) => id === snapshot.providerId)?.providerId ?? '';
      const activeRequests =
        activity.byProvider[snapshot.providerId] ?? activity.byProvider[providerId] ?? 0;
      return {
        ...snapshot,
        activeRequests,
        freshness: activeRequests > 0 ? ('live' as const) : snapshot.freshness,
      };
    });
    taskbarUsageStore.publish({
      snapshots: withLiveActivity,
      totalActiveRequests: activity.total,
      publishedAt: Date.now(),
    });
  };

  const refresh = async (force = false, providerId?: string): Promise<void> => {
    if (!taskbarUsageStore.getSnapshot().preferences.enabled || stopped) return;
    await refreshCoordinator
      .run(
        `automatic-provider-discovery:${providerId ?? 'all'}`,
        async () => {
          await ensureExternalConnectionAutoDetection().catch(() => undefined);
          const auth = useAuthStore.getState();
          const connectedProviderIds = getConnectedProviders({
            apiKeys: auth.apiKeys,
            offlineMode: auth.offlineMode,
            plan: auth.plan,
            defaultLocalModel: auth.defaultLocalModel,
          });
          const usageConnections = PROVIDER_CONNECTIONS.map((connection) =>
            auth.chatModelSelection.mode === 'single' &&
            auth.chatModelSelection.connectionId === connection.id
              ? { ...connection, modelId: auth.chatModelSelection.modelId }
              : connection,
          );
          if (stopped) return;
          let refreshedSnapshots = buildAutomaticProviderSnapshots({
            connections: usageConnections,
            connectedProviderIds,
            connectionMetadata: readConnectionMetadata(),
            connectionUsage: Object.fromEntries(
              usageConnections.map((connection) => {
                const usage = aggregateConnectionUsage(
                  connection.id,
                  Date.now() - 30 * 24 * 60 * 60 * 1_000,
                  connection.modelId,
                );
                return [
                  connection.id,
                  {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cachedTokens: usage.cachedInputTokens,
                    totalTokens: usage.totalTokens,
                    costUsd: usage.costUsd,
                    calls: usage.requests,
                    lastUsed: usage.lastRequestAt,
                  },
                ];
              }),
            ),
            activity: providerActivityTracker.snapshot(),
            now: Date.now(),
          });
          if (usageConnections.some(supportsCodexAccountUsage)) {
            try {
              const codexUsage = await readCodexAccountUsage();
              refreshedSnapshots = mergeCodexAccountUsageSnapshots(
                refreshedSnapshots,
                usageConnections,
                codexUsage,
              );
            } catch {
              refreshedSnapshots = markCodexAccountUsageError(refreshedSnapshots, usageConnections);
            }
          }
          snapshots = providerId
            ? [
                ...snapshots.filter(
                  (snapshot) =>
                    snapshot.providerId !== providerId && snapshot.providerFamilyId !== providerId,
                ),
                ...refreshedSnapshots.filter(
                  (snapshot) =>
                    snapshot.providerId === providerId || snapshot.providerFamilyId === providerId,
                ),
              ]
            : refreshedSnapshots;
          publish();
          return true;
        },
        {
          ttlMs: document.hidden ? BACKGROUND_PROVIDER_REFRESH_MS : FOREGROUND_PROVIDER_REFRESH_MS,
          force,
        },
      )
      .catch(() => {
        snapshots = snapshots.map((snapshot) => ({
          ...snapshot,
          freshness: 'error',
          errorCode: 'PROVIDER_USAGE_UNAVAILABLE',
        }));
        publish();
      });
  };

  const ensureVisibleWindow = async (): Promise<void> => {
    try {
      await ensureTaskbarUsageWindow();
      taskbarUsageStore.setRuntimeDiagnostic(null);
    } catch {
      taskbarUsageStore.setRuntimeDiagnostic({
        code: 'WINDOW_CREATE_FAILED',
        message: 'The desktop usage window could not be created. Retry or restart VibeSpace.',
        occurredAt: Date.now(),
        retryable: true,
      });
    }
  };

  const syncLifecycle = () => {
    const preferences = taskbarUsageStore.getSnapshot().preferences;
    const key = JSON.stringify({
      enabled: preferences.enabled,
      launchWithVibeSpace: preferences.launchWithVibeSpace,
      placement: preferences.placement,
      collapsed: preferences.collapsed,
    });
    if (key === lastPreferencesKey) return;
    lastPreferencesKey = key;

    window.clearInterval(displayTimer);
    displayTimer = undefined;
    if (!preferences.enabled) {
      void hideTaskbarUsageWindow().catch(() => undefined);
      taskbarUsageStore.setRuntimeDiagnostic(null);
      return;
    }
    if (mainVisible || preferences.launchWithVibeSpace) {
      void ensureVisibleWindow();
    } else {
      void hideTaskbarUsageWindow().catch(() => undefined);
    }
    void refresh(true);
    displayTimer = window.setInterval(() => {
      void refresh();
    }, DISPLAY_REFRESH_MS);
  };

  const unsubscribeStore = taskbarUsageStore.subscribe(syncLifecycle);
  const unsubscribeAuth = useAuthStore.subscribe(() => void refresh(true));
  const unsubscribeActivity = providerActivityTracker.subscribe(() => {
    publish();
  });

  const handleOnline = () => {
    refreshCoordinator.setOnline(true);
    void refresh(true);
  };
  const handleOffline = () => {
    refreshCoordinator.setOnline(false);
    snapshots = snapshots.map((snapshot) => ({ ...snapshot, freshness: 'offline' }));
    publish();
  };
  const handleVisibility = () => {
    if (!document.hidden) void refresh(true);
  };
  const handleManualRefresh = (event: Event) => {
    const providerId =
      event instanceof CustomEvent && typeof event.detail?.providerId === 'string'
        ? event.detail.providerId
        : undefined;
    void refresh(true, providerId);
  };
  const handleRetryMount = () => {
    if (taskbarUsageStore.getSnapshot().preferences.enabled) {
      void ensureVisibleWindow();
    }
  };
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  window.addEventListener('taskbar-usage://refresh', handleManualRefresh);
  window.addEventListener('taskbar-usage://retry-mount', handleRetryMount);
  document.addEventListener('visibilitychange', handleVisibility);

  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) => {
        const retain = (registration: Promise<() => void>) => {
          void registration
            .then((unlisten) => nativeUnlisteners.add(unlisten))
            .catch(() => undefined);
        };
        retain(
          listen('jarvis:before-hide', () => {
            mainVisible = false;
            lastPreferencesKey = '';
            syncLifecycle();
          }),
        );
        retain(
          listen('jarvis:reopen', () => {
            mainVisible = true;
            lastPreferencesKey = '';
            syncLifecycle();
          }),
        );
        retain(
          listen<{ providerId?: string }>('taskbar-usage://open-connections', (event) => {
            void showMainWindowConnections(event.payload?.providerId);
          }),
        );
        retain(
          listen<{ providerId?: string }>('taskbar-usage://refresh', (event) => {
            void refresh(true, event.payload?.providerId);
          }),
        );
      })
      .catch(() => undefined);
  }

  syncLifecycle();
  stopController = () => {
    stopped = true;
    window.clearInterval(displayTimer);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('taskbar-usage://refresh', handleManualRefresh);
    window.removeEventListener('taskbar-usage://retry-mount', handleRetryMount);
    document.removeEventListener('visibilitychange', handleVisibility);
    unsubscribeStore();
    unsubscribeAuth();
    unsubscribeActivity();
    nativeUnlisteners.stop();
    stopController = undefined;
  };
  return stopController;
}
