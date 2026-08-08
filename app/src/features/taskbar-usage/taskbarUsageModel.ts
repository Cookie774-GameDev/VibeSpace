import type {
  ProviderUsageSnapshot,
  TaskbarEdge,
  TaskbarUsagePreferences,
} from './providerUsageTypes';

export const TASKBAR_USAGE_STORAGE_KEY = 'vibespace.taskbar-usage.v1';
export const DEFAULT_TASKBAR_USAGE_PREFERENCES: TaskbarUsagePreferences = Object.freeze({
  enabled: true,
  launchWithVibeSpace: true,
  providerOrder: [],
  hiddenProviderIds: [],
  pinnedProviderIds: [],
  registrySort: 'active',
  detailsOpen: false,
  placement: null,
  collapsed: false,
});

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
const EDGES = new Set<TaskbarEdge>(['top', 'right', 'bottom', 'left']);

function uniqueProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate === 'string' && PROVIDER_ID.test(candidate)) ids.add(candidate);
  }
  return [...ids];
}

export function normalizeTaskbarUsagePreferences(value: unknown): TaskbarUsagePreferences {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const placement =
    typeof record.placement === 'object' && record.placement !== null
      ? (record.placement as Record<string, unknown>)
      : null;
  const validPlacement =
    placement &&
    typeof placement.monitorName === 'string' &&
    placement.monitorName.length > 0 &&
    placement.monitorName.length <= 160 &&
    typeof placement.edge === 'string' &&
    EDGES.has(placement.edge as TaskbarEdge) &&
    typeof placement.offset === 'number' &&
    Number.isFinite(placement.offset) &&
    placement.offset >= 0
      ? {
          monitorName: placement.monitorName,
          edge: placement.edge as TaskbarEdge,
          offset: Math.round(placement.offset),
        }
      : null;

  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : DEFAULT_TASKBAR_USAGE_PREFERENCES.enabled,
    launchWithVibeSpace:
      typeof record.launchWithVibeSpace === 'boolean'
        ? record.launchWithVibeSpace
        : DEFAULT_TASKBAR_USAGE_PREFERENCES.launchWithVibeSpace,
    providerOrder: uniqueProviderIds(record.providerOrder),
    hiddenProviderIds: uniqueProviderIds(record.hiddenProviderIds),
    pinnedProviderIds: uniqueProviderIds(record.pinnedProviderIds),
    registrySort:
      record.registrySort === 'warning' ||
      record.registrySort === 'usage' ||
      record.registrySort === 'name' ||
      record.registrySort === 'recent'
        ? record.registrySort
        : 'active',
    detailsOpen: record.detailsOpen === true,
    placement: validPlacement,
    collapsed:
      typeof record.collapsed === 'boolean'
        ? record.collapsed
        : DEFAULT_TASKBAR_USAGE_PREFERENCES.collapsed,
  };
}

export function readTaskbarUsagePreferences(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): TaskbarUsagePreferences {
  if (!storage) return { ...DEFAULT_TASKBAR_USAGE_PREFERENCES };
  try {
    return normalizeTaskbarUsagePreferences(
      JSON.parse(storage.getItem(TASKBAR_USAGE_STORAGE_KEY) ?? '{}'),
    );
  } catch {
    return { ...DEFAULT_TASKBAR_USAGE_PREFERENCES };
  }
}

export function writeTaskbarUsagePreferences(
  preferences: TaskbarUsagePreferences,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): TaskbarUsagePreferences {
  const normalized = normalizeTaskbarUsagePreferences(preferences);
  try {
    storage?.setItem(TASKBAR_USAGE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The in-memory caller remains authoritative for this session.
  }
  return normalized;
}

export function selectVisibleProviderSnapshots(
  snapshots: readonly ProviderUsageSnapshot[],
  preferences: Pick<
    TaskbarUsagePreferences,
    'providerOrder' | 'hiddenProviderIds' | 'pinnedProviderIds'
  >,
): ProviderUsageSnapshot[] {
  const hidden = new Set(preferences.hiddenProviderIds);
  const pinned = new Set(preferences.pinnedProviderIds);
  const order = new Map(preferences.providerOrder.map((id, index) => [id, index]));
  return snapshots
    .filter(({ connected, hidden: adapterHidden, providerId }) => {
      return connected && !adapterHidden && !hidden.has(providerId);
    })
    .sort((left, right) => {
      const leftOrder = order.get(left.providerId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right.providerId) ?? Number.MAX_SAFE_INTEGER;
      const pinnedDifference =
        Number(pinned.has(right.providerId)) - Number(pinned.has(left.providerId));
      if (pinnedDifference !== 0) return pinnedDifference;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      const leftPriority =
        (left.activeRequests > 0 ? 3 : 0) +
        ((left.usagePercent ?? 0) >= 85 ? 2 : (left.usagePercent ?? 0) >= 70 ? 1 : 0);
      const rightPriority =
        (right.activeRequests > 0 ? 3 : 0) +
        ((right.usagePercent ?? 0) >= 85 ? 2 : (right.usagePercent ?? 0) >= 70 ? 1 : 0);
      return (
        rightPriority - leftPriority ||
        right.updatedAt - left.updatedAt ||
        left.displayName.localeCompare(right.displayName) ||
        left.providerId.localeCompare(right.providerId)
      );
    })
    .slice(0, 4);
}

export function snapshotFreshnessLabel(
  snapshot: ProviderUsageSnapshot,
  now = Date.now(),
): string | null {
  if (snapshot.freshness === 'offline') return 'Offline';
  if (snapshot.freshness === 'error') return 'Unavailable';
  const ageMs = Math.max(0, now - snapshot.updatedAt);
  if (snapshot.freshness !== 'stale' && ageMs < 120_000) return null;
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  return `Updated ${minutes}m ago`;
}

export function safeAggregateUsdSpend(snapshots: readonly ProviderUsageSnapshot[]): number | null {
  const monetary = snapshots.filter(
    (snapshot) =>
      snapshot.connected &&
      snapshot.usageUnit === 'usd' &&
      snapshot.usageValue !== null &&
      Number.isFinite(snapshot.usageValue),
  );
  if (monetary.length === 0) return null;
  if (monetary.length > 1) {
    const scope = monetary[0]?.planScope;
    if (!scope || monetary.some((snapshot) => snapshot.planScope !== scope)) return null;
  }
  return Number(
    monetary.reduce((total, snapshot) => total + (snapshot.usageValue ?? 0), 0).toFixed(2),
  );
}

export function reconcileProviderAndLocalUsage(input: {
  providerValue: number | null;
  providerUnit: ProviderUsageSnapshot['usageUnit'];
  localValue: number | null;
  localUnit: ProviderUsageSnapshot['usageUnit'];
  tolerance?: number;
}): NonNullable<ProviderUsageSnapshot['reconciliation']> {
  const { providerValue, providerUnit, localValue, localUnit } = input;
  if (
    providerValue === null ||
    localValue === null ||
    !providerUnit ||
    providerUnit !== localUnit ||
    !Number.isFinite(providerValue) ||
    !Number.isFinite(localValue)
  ) {
    return 'not_comparable';
  }
  const tolerance = Math.max(0, input.tolerance ?? Math.max(0.01, providerValue * 0.01));
  if (Math.abs(providerValue - localValue) <= tolerance) return 'matched';
  return providerValue > localValue ? 'provider_ahead' : 'local_ahead';
}
