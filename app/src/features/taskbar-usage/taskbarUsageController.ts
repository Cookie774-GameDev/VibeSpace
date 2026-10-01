import { PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import { ensureExternalConnectionAutoDetection } from '@/lib/ai/adapters/autoDetectConnections';
import { readConnectionMetadata } from '@/lib/ai/connectionState';
import { getConnectedProviders } from '@/lib/ai/providerRegistry';
import { getMonthlyAllProviderUsage } from '@/lib/usage/usageSummary';
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
import { readCodexAccountUsage } from '@/lib/ai/adapters/codexAccountUsage';
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
          const localUsage = await getMonthlyAllProviderUsage(connectedProviderIds).catch(
            () => ({}),
          );
          if (stopped) return;
          let refreshedSnapshots = buildAutomaticProviderSnapshots({
            connections: PROVIDER_CONNECTIONS,
            connectedProviderIds,
            connectionMetadata: readConnectionMetadata(),
            localUsage,
            connectionUsage: Object.fromEntries(
              PROVIDER_CONNECTIONS.map((connection) => {
                const usage = aggregateConnectionUsage(
                  connection.id,
                  Date.now() - 30 * 24 * 60 * 60 * 1_000,
                );
                return [
                  connection.id,
                  {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cachedTokens: usage.cachedInputTokens,
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
          if (refreshedSnapshots.some((snapshot) => snapshot.providerId === 'openai-codex')) {
            try {
              const codexUsage = await readCodexAccountUsage();
              const primary = codexUsage.windows[0];
              refreshedSnapshots = refreshedSnapshots.map((snapshot) =>
                snapshot.providerId === 'openai-codex'
                  ? {
                      ...snapshot,
                      ...(primary
                        ? {
                            usageValue: primary.usedPercent,
                            usageLimit: 100,
                            usageUnit: 'percent' as const,
                            usagePercent: primary.usedPercent,
                            resetAt: primary.resetsAt,
                          }
                        : {}),
                      planScope: [
                        codexUsage.planType,
                        codexUsage.windows
                          .map((window) => `${window.label} ${window.usedPercent}%`)
                          .join(' · '),
                        codexUsage.creditsRemaining === null
                          ? null
                          : `${codexUsage.creditsRemaining} credits`,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                      source: 'provider-api' as const,
                      updatedAt: codexUsage.updatedAt,
                      freshness: 'fresh' as const,
                    }
                  : snapshot,
              );
            } catch {
              // Exact-route local usage remains available with honest terminal provenance.
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
