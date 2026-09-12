import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  ListFilter,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import type { TaskbarUsagePayload, TaskbarUsagePreferences } from './providerUsageTypes';
import { safeAggregateUsdSpend, selectVisibleProviderSnapshots } from './taskbarUsageModel';
import { ProviderUsageRow } from './ProviderUsageRow';
import { requestOpenConnections } from './taskbarUsageNativeWindow';
import { UsageSyncAge } from './UsageSyncAge';

interface TaskbarUsageCompactProps {
  payload: TaskbarUsagePayload;
  preferences: TaskbarUsagePreferences;
  onToggleCollapsed(): void;
  onOpenReorder(): void;
  onOpenExpanded(): void;
  onRefresh(): void;
}

export function TaskbarUsageCompact({
  payload,
  preferences,
  onToggleCollapsed,
  onOpenReorder,
  onOpenExpanded,
  onRefresh,
}: TaskbarUsageCompactProps) {
  const visible = selectVisibleProviderSnapshots(payload.snapshots, preferences);
  const count = payload.totalActiveRequests;
  const connectedCount = payload.snapshots.filter(({ connected }) => connected).length;
  const warningCount = payload.snapshots.filter(
    ({ usagePercent }) => (usagePercent ?? 0) >= 70,
  ).length;
  const aggregateSpend = safeAggregateUsdSpend(payload.snapshots);
  return (
    <section
      className="taskbar-usage-surface"
      aria-label="VibeSpace AI usage"
      title={`${connectedCount} connected providers · ${warningCount} usage warnings`}
      data-collapsed={preferences.collapsed}
    >
      <header className="taskbar-usage-header" data-tauri-drag-region>
        <GripVertical className="taskbar-usage-drag" aria-hidden="true" data-tauri-drag-region />
        <span className="taskbar-usage-live-dot" aria-hidden="true" />
        <strong>Live</strong>
        <span className="taskbar-usage-active-count">
          {count} active {count === 1 ? 'request' : 'requests'}
        </span>
        {!preferences.collapsed && (
          <>
            <button type="button" onClick={onRefresh} aria-label="Refresh provider usage">
              <RefreshCw aria-hidden="true" />
            </button>
            <button type="button" onClick={onOpenReorder} aria-label="Reorder usage providers">
              <SlidersHorizontal aria-hidden="true" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={preferences.collapsed ? 'Expand usage module' : 'Collapse usage module'}
        >
          {preferences.collapsed ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </button>
      </header>
      {!preferences.collapsed && (
        <div className="taskbar-usage-provider-list">
          {visible.length === 0 ? (
            <button
              type="button"
              className="taskbar-usage-empty"
              onClick={() => void requestOpenConnections()}
            >
              <span>No AI providers connected</span>
              <strong>Open Connections</strong>
            </button>
          ) : (
            visible.map((snapshot) => (
              <ProviderUsageRow key={snapshot.providerId} snapshot={snapshot} />
            ))
          )}
          <button
            type="button"
            className="taskbar-usage-view-all"
            onClick={onOpenExpanded}
            aria-label="View all providers"
          >
            <ListFilter aria-hidden="true" />
            <span>View all providers</span>
            <small>
              {visible.length} of {payload.snapshots.length}
            </small>
          </button>
          <UsageSyncAge updatedAt={payload.publishedAt} />
          <div className="taskbar-usage-compact-summary" aria-label="Provider usage summary">
            <span>{connectedCount} connected</span>
            <span>{warningCount} warnings</span>
            {aggregateSpend !== null && <span>${aggregateSpend.toFixed(2)} tracked</span>}
          </div>
        </div>
      )}
    </section>
  );
}
