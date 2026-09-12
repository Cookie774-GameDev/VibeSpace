import type {
  TaskbarUsagePayload,
  TaskbarUsagePreferences,
  TaskbarUsagePlacement,
  TaskbarUsageRuntimeDiagnostic,
} from './providerUsageTypes';
import {
  DEFAULT_TASKBAR_USAGE_PREFERENCES,
  readTaskbarUsagePreferences,
  writeTaskbarUsagePreferences,
} from './taskbarUsageModel';

const PAYLOAD_STORAGE_KEY = 'vibespace.taskbar-usage.payload.v1';
const CHANGE_EVENT = 'vibespace:taskbar-usage:changed';

export interface TaskbarUsageStoreSnapshot {
  preferences: TaskbarUsagePreferences;
  payload: TaskbarUsagePayload;
  runtimeDiagnostic: TaskbarUsageRuntimeDiagnostic | null;
}

const emptyPayload = (): TaskbarUsagePayload => ({
  snapshots: [],
  totalActiveRequests: 0,
  publishedAt: 0,
});

function readPayload(): TaskbarUsagePayload {
  try {
    const value = JSON.parse(
      localStorage.getItem(PAYLOAD_STORAGE_KEY) ?? '{}',
    ) as Partial<TaskbarUsagePayload>;
    return {
      snapshots: Array.isArray(value.snapshots) ? value.snapshots.slice(0, 64) : [],
      totalActiveRequests:
        typeof value.totalActiveRequests === 'number'
          ? Math.max(0, Math.floor(value.totalActiveRequests))
          : 0,
      publishedAt:
        typeof value.publishedAt === 'number' && Number.isSafeInteger(value.publishedAt)
          ? value.publishedAt
          : 0,
    };
  } catch {
    return emptyPayload();
  }
}

let state: TaskbarUsageStoreSnapshot = {
  preferences:
    typeof window === 'undefined'
      ? { ...DEFAULT_TASKBAR_USAGE_PREFERENCES }
      : readTaskbarUsagePreferences(),
  payload: typeof window === 'undefined' ? emptyPayload() : readPayload(),
  runtimeDiagnostic: null,
};
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

function setPreferences(preferences: TaskbarUsagePreferences): void {
  state = {
    ...state,
    preferences: writeTaskbarUsagePreferences(preferences),
  };
  notify();
}

export const taskbarUsageStore = {
  getSnapshot: (): TaskbarUsageStoreSnapshot => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  updatePreferences(
    update:
      | Partial<TaskbarUsagePreferences>
      | ((current: TaskbarUsagePreferences) => TaskbarUsagePreferences),
  ): void {
    setPreferences(
      typeof update === 'function'
        ? update(state.preferences)
        : { ...state.preferences, ...update },
    );
  },
  publish(payload: TaskbarUsagePayload): void {
    const bounded: TaskbarUsagePayload = {
      snapshots: payload.snapshots.slice(0, 64),
      totalActiveRequests: Math.max(0, Math.floor(payload.totalActiveRequests)),
      publishedAt: payload.publishedAt,
    };
    const persistentChanged =
      state.payload.totalActiveRequests !== bounded.totalActiveRequests ||
      JSON.stringify(state.payload.snapshots) !== JSON.stringify(bounded.snapshots);
    state = { ...state, payload: bounded };
    if (persistentChanged) {
      try {
        localStorage.setItem(PAYLOAD_STORAGE_KEY, JSON.stringify(bounded));
      } catch {
        // Current-session data remains usable.
      }
    }
    notify();
  },
  setRuntimeDiagnostic(runtimeDiagnostic: TaskbarUsageRuntimeDiagnostic | null): void {
    state = { ...state, runtimeDiagnostic };
    notify();
  },
  moveProvider(providerId: string, direction: -1 | 1): void {
    setPreferences({
      ...state.preferences,
      providerOrder: moveProviderInOrder(
        state.preferences.providerOrder,
        state.payload.snapshots.map(({ providerId: id }) => id),
        providerId,
        direction,
      ),
    });
  },
  moveProviderTo(providerId: string, targetIndex: number): void {
    setPreferences({
      ...state.preferences,
      providerOrder: moveProviderToIndex(
        state.preferences.providerOrder,
        state.payload.snapshots.map(({ providerId: id }) => id),
        providerId,
        targetIndex,
      ),
    });
  },
  setProviderHidden(providerId: string, hidden: boolean): void {
    const ids = new Set(state.preferences.hiddenProviderIds);
    if (hidden) ids.add(providerId);
    else ids.delete(providerId);
    setPreferences({ ...state.preferences, hiddenProviderIds: [...ids] });
  },
  setProviderPinned(providerId: string, pinned: boolean): void {
    const ids = new Set(state.preferences.pinnedProviderIds);
    if (pinned) ids.add(providerId);
    else ids.delete(providerId);
    setPreferences({ ...state.preferences, pinnedProviderIds: [...ids] });
  },
  resetProviderOrder(): void {
    setPreferences({
      ...state.preferences,
      providerOrder: state.payload.snapshots.map(({ providerId }) => providerId),
      hiddenProviderIds: [],
    });
  },
  setPlacement(placement: TaskbarUsagePlacement | null): void {
    setPreferences({ ...state.preferences, placement });
  },
};

export function moveProviderInOrder(
  persistedOrder: readonly string[],
  availableIds: readonly string[],
  providerId: string,
  direction: -1 | 1,
): string[] {
  const order = [...new Set([...persistedOrder, ...availableIds])];
  const index = order.indexOf(providerId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return order;
  [order[index], order[target]] = [order[target], order[index]];
  return order;
}

export function moveProviderToIndex(
  persistedOrder: readonly string[],
  availableIds: readonly string[],
  providerId: string,
  targetIndex: number,
): string[] {
  const order = [...new Set([...persistedOrder, ...availableIds])];
  if (!order.includes(providerId)) return order;
  const withoutDragged = order.filter((id) => id !== providerId);
  const boundedIndex = Math.min(Math.max(0, Math.floor(targetIndex)), withoutDragged.length);
  withoutDragged.splice(boundedIndex, 0, providerId);
  return withoutDragged;
}

export function resetTaskbarUsageStoreForTests(): void {
  state = {
    preferences: readTaskbarUsagePreferences(),
    payload: emptyPayload(),
    runtimeDiagnostic: null,
  };
  notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'vibespace.taskbar-usage.v1' && event.key !== PAYLOAD_STORAGE_KEY) {
      return;
    }
    state = {
      preferences: readTaskbarUsagePreferences(),
      payload: readPayload(),
      runtimeDiagnostic: state.runtimeDiagnostic,
    };
    notify();
  });
}
