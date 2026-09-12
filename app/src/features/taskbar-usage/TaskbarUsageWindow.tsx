import { useEffect, useState, useSyncExternalStore } from 'react';
import { TaskbarUsageCompact } from './TaskbarUsageCompact';
import { TaskbarUsageReorder } from './TaskbarUsageReorder';
import {
  TASKBAR_USAGE_COLLAPSED_SIZE,
  TASKBAR_USAGE_DETAILS_SIZE,
  TASKBAR_USAGE_EXPANDED_SIZE,
  requestOpenConnections,
  requestTaskbarUsageRefresh,
  resizeAndPlaceTaskbarUsageWindow,
  startTaskbarUsageSnapListener,
} from './taskbarUsageNativeWindow';
import { taskbarUsageStore } from './taskbarUsageStore';
import { TaskbarUsageExpanded } from './TaskbarUsageExpanded';
import './taskbarUsage.css';

export function TaskbarUsageWindow() {
  const state = useSyncExternalStore(
    taskbarUsageStore.subscribe,
    taskbarUsageStore.getSnapshot,
    taskbarUsageStore.getSnapshot,
  );
  const [reorderOpen, setReorderOpen] = useState(false);
  const detailsOpen = state.preferences.detailsOpen;

  useEffect(() => {
    const size = detailsOpen
      ? TASKBAR_USAGE_DETAILS_SIZE
      : state.preferences.collapsed
        ? TASKBAR_USAGE_COLLAPSED_SIZE
        : TASKBAR_USAGE_EXPANDED_SIZE;
    void resizeAndPlaceTaskbarUsageWindow(size, state.preferences.placement);
  }, [detailsOpen, state.preferences.collapsed, state.preferences.placement]);

  useEffect(() => {
    let stop: () => void = () => undefined;
    void startTaskbarUsageSnapListener().then((unlisten) => {
      stop = unlisten;
    });
    return () => stop();
  }, []);

  if (detailsOpen && !state.preferences.collapsed) {
    return (
      <TaskbarUsageExpanded
        payload={state.payload}
        pinnedProviderIds={state.preferences.pinnedProviderIds}
        sort={state.preferences.registrySort}
        onClose={() => taskbarUsageStore.updatePreferences({ detailsOpen: false })}
        onRefresh={(providerId) => void requestTaskbarUsageRefresh(providerId)}
        onOpenConnections={(providerId) => void requestOpenConnections(providerId)}
        onSortChange={(registrySort) => taskbarUsageStore.updatePreferences({ registrySort })}
        onTogglePinned={(providerId, pinned) =>
          taskbarUsageStore.setProviderPinned(providerId, pinned)
        }
      />
    );
  }

  if (reorderOpen && !state.preferences.collapsed) {
    return (
      <TaskbarUsageReorder
        state={state}
        onMove={(providerId, direction) => taskbarUsageStore.moveProvider(providerId, direction)}
        onMoveTo={(providerId, targetIndex) =>
          taskbarUsageStore.moveProviderTo(providerId, targetIndex)
        }
        onToggleHidden={(providerId, hidden) =>
          taskbarUsageStore.setProviderHidden(providerId, hidden)
        }
        onReset={() => taskbarUsageStore.resetProviderOrder()}
        onClose={() => setReorderOpen(false)}
      />
    );
  }

  return (
    <TaskbarUsageCompact
      payload={state.payload}
      preferences={state.preferences}
      onToggleCollapsed={() =>
        taskbarUsageStore.updatePreferences({
          collapsed: !state.preferences.collapsed,
        })
      }
      onOpenReorder={() => setReorderOpen(true)}
      onOpenExpanded={() => taskbarUsageStore.updatePreferences({ detailsOpen: true })}
      onRefresh={() => void requestTaskbarUsageRefresh()}
    />
  );
}
