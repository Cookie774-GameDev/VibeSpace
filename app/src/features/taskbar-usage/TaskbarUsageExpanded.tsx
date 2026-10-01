import { useMemo, useState } from 'react';
import { ExternalLink, Clipboard, Pin, PinOff, RefreshCw, Settings2, X } from 'lucide-react';
import { openExternal } from '@/lib/tauri';
import { PROVIDER_USAGE_DEFINITIONS } from './providerUsageRegistry';
import type {
  ProviderUsageDefinition,
  ProviderUsageRegistrySort,
  ProviderUsageSnapshot,
  TaskbarUsagePayload,
} from './providerUsageTypes';
import { UsageSyncAge } from './UsageSyncAge';

type RegistryFilter =
  | 'all'
  | 'connected'
  | 'warning'
  | 'local'
  | 'cloud'
  | 'speech'
  | 'unsupported';
interface RegistryRow {
  definition: ProviderUsageDefinition;
  snapshot?: ProviderUsageSnapshot;
}

export type UsageWarningSeverity = 'none' | 'notice' | 'high' | 'critical';

export function usageWarningSeverity(percent: number | null | undefined): UsageWarningSeverity {
  if (percent === null || percent === undefined || percent < 70) return 'none';
  if (percent >= 95) return 'critical';
  if (percent >= 85) return 'high';
  return 'notice';
}

function mergeRegistry(payload: TaskbarUsagePayload): RegistryRow[] {
  return PROVIDER_USAGE_DEFINITIONS.map((definition) => ({
    definition,
    snapshot: payload.snapshots
      .filter(
        (snapshot) =>
          snapshot.providerFamilyId === definition.id || snapshot.providerId === definition.id,
      )
      .sort(
        (left, right) =>
          right.activeRequests - left.activeRequests || right.updatedAt - left.updatedAt,
      )[0],
  })).sort((left, right) => {
    const leftConnected = left.snapshot?.connected ? 1 : 0;
    const rightConnected = right.snapshot?.connected ? 1 : 0;
    return (
      rightConnected - leftConnected ||
      left.definition.displayName.localeCompare(right.definition.displayName)
    );
  });
}

function metricLabel(row: RegistryRow): string {
  const { snapshot, definition } = row;
  if (!snapshot?.connected) return 'Not connected';
  if (snapshot.freshness === 'error') return 'Usage sync failed';
  if (snapshot.usageValue === 0 && snapshot.source === 'provider-api') {
    return 'No usage recorded this period';
  }
  if (snapshot.usageValue !== null && snapshot.usageUnit) {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      snapshot.usageValue,
    )} ${snapshot.usageUnit}`;
  }
  if (definition.usageCapability === 'unsupported') return 'Usage API unavailable';
  if (snapshot.source === 'terminal-session') return 'CLI quota unavailable';
  return 'No local usage recorded';
}

function matchesFilter(row: RegistryRow, filter: RegistryFilter): boolean {
  if (filter === 'connected') return row.snapshot?.connected === true;
  if (filter === 'warning') return (row.snapshot?.usagePercent ?? 0) >= 70;
  if (filter === 'local') {
    return row.definition.routes.some(({ type }) => type === 'local_runtime');
  }
  if (filter === 'cloud') {
    return row.definition.routes.some(({ type }) => type !== 'local_runtime');
  }
  if (filter === 'speech') return row.definition.category === 'speech';
  if (filter === 'unsupported') return row.definition.usageCapability === 'unsupported';
  return true;
}

function sortRows(rows: RegistryRow[], sort: ProviderUsageRegistrySort): RegistryRow[] {
  return [...rows].sort((left, right) => {
    if (sort === 'name') {
      return left.definition.displayName.localeCompare(right.definition.displayName);
    }
    if (sort === 'warning' || sort === 'usage') {
      return (
        (right.snapshot?.usagePercent ?? -1) - (left.snapshot?.usagePercent ?? -1) ||
        left.definition.displayName.localeCompare(right.definition.displayName)
      );
    }
    if (sort === 'recent') {
      return (
        (right.snapshot?.updatedAt ?? 0) - (left.snapshot?.updatedAt ?? 0) ||
        left.definition.displayName.localeCompare(right.definition.displayName)
      );
    }
    return (
      (right.snapshot?.activeRequests ?? 0) - (left.snapshot?.activeRequests ?? 0) ||
      Number(right.snapshot?.connected ?? false) - Number(left.snapshot?.connected ?? false) ||
      (right.snapshot?.updatedAt ?? 0) - (left.snapshot?.updatedAt ?? 0) ||
      left.definition.displayName.localeCompare(right.definition.displayName)
    );
  });
}

const FILTERS: readonly { id: RegistryFilter; label: string }[] = [
  { id: 'all', label: 'All providers' },
  { id: 'connected', label: 'Connected providers' },
  { id: 'warning', label: 'Usage warnings' },
  { id: 'local', label: 'Local providers' },
  { id: 'cloud', label: 'Cloud providers' },
  { id: 'speech', label: 'Speech providers' },
  { id: 'unsupported', label: 'Usage API unsupported' },
];

export function TaskbarUsageExpanded({
  payload,
  pinnedProviderIds,
  sort,
  onClose,
  onRefresh,
  onOpenConnections,
  onSortChange,
  onTogglePinned,
}: {
  payload: TaskbarUsagePayload;
  pinnedProviderIds: readonly string[];
  sort: ProviderUsageRegistrySort;
  onClose(): void;
  onRefresh(providerId?: string): void;
  onOpenConnections(providerId?: string): void;
  onSortChange(sort: ProviderUsageRegistrySort): void;
  onTogglePinned(providerId: string, pinned: boolean): void;
}) {
  const [filter, setFilter] = useState<RegistryFilter>('all');
  const [currentSort, setCurrentSort] = useState<ProviderUsageRegistrySort>(sort);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      sortRows(
        mergeRegistry(payload).filter((row) => matchesFilter(row, filter)),
        currentSort,
      ),
    [currentSort, filter, payload],
  );
  const connectedCount = payload.snapshots.filter(({ connected }) => connected).length;
  const warningCount = payload.snapshots.filter(
    ({ usagePercent }) => (usagePercent ?? 0) >= 70,
  ).length;
  const selected = rows.find(({ definition }) => definition.id === selectedProviderId);
  const diagnostic = selected
    ? JSON.stringify(
        {
          provider: selected.definition.displayName,
          route: selected.snapshot?.routeLabel ?? selected.definition.routes[0]?.label,
          status: selected.snapshot?.connectionState ?? 'disconnected',
          source: selected.snapshot?.source ?? 'unavailable',
          providerMetric: selected.snapshot?.usageValue ?? null,
          localMetric: selected.snapshot?.localUsageValue ?? null,
          reconciliation: selected.snapshot?.reconciliation ?? 'not_comparable',
          freshness: selected.snapshot?.freshness ?? 'expired',
          cacheAgeSeconds: selected.snapshot
            ? Math.max(0, Math.floor((Date.now() - selected.snapshot.updatedAt) / 1_000))
            : null,
          lastSuccessfulSync: selected.snapshot?.updatedAt ?? null,
          lastAttempt: selected.snapshot?.lastAttemptAt ?? null,
          retryAt: selected.snapshot?.retryAt ?? null,
          rateLimitState:
            selected.snapshot?.rateLimitState ??
            (selected.snapshot?.retryAt ? 'limited' : 'unknown'),
          errorCode: selected.snapshot?.errorCode ?? null,
        },
        null,
        2,
      )
    : '';

  return (
    <section className="taskbar-usage-details" aria-label="All provider usage">
      <header className="taskbar-usage-details-header">
        <div>
          <strong>Usage</strong>
          <span>
            {connectedCount} connected · {warningCount} warnings
          </span>
          <UsageSyncAge updatedAt={payload.publishedAt} />
        </div>
        <button type="button" onClick={() => onRefresh()} aria-label="Refresh provider usage">
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onOpenConnections()}
          aria-label="Open provider settings"
        >
          <Settings2 aria-hidden="true" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close all provider usage">
          <X aria-hidden="true" />
        </button>
      </header>
      <nav className="taskbar-usage-filters" aria-label="Provider usage filters">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            aria-label={item.label}
            onClick={() => setFilter(item.id)}
          >
            {item.label.replace(' providers', '')}
          </button>
        ))}
        <label className="taskbar-usage-sort">
          <span>Sort providers</span>
          <select
            aria-label="Sort providers"
            value={currentSort}
            onChange={(event) => {
              const nextSort = event.target.value as ProviderUsageRegistrySort;
              setCurrentSort(nextSort);
              onSortChange(nextSort);
            }}
          >
            <option value="active">Active</option>
            <option value="warning">Warning</option>
            <option value="usage">Highest usage</option>
            <option value="name">Provider name</option>
            <option value="recent">Recently used</option>
          </select>
        </label>
      </nav>
      <div className="taskbar-usage-source-legend" aria-label="Usage data source legend">
        <strong>Sources</strong>
        <span>Provider API = provider-reported</span>
        <span>Local events/runtime = measured by VibeSpace</span>
        <span>Estimate = calculated, not provider quota</span>
        <span>Unavailable = no truthful metric</span>
      </div>
      <div className="taskbar-usage-registry" role="list">
        {rows.map((row) => {
          const { definition, snapshot } = row;
          const percent = snapshot?.usagePercent;
          return (
            <article
              key={definition.id}
              className="taskbar-usage-registry-row"
              data-testid="usage-registry-row"
              role="listitem"
              data-warning={usageWarningSeverity(percent)}
            >
              <div className="taskbar-usage-registry-heading">
                <span className="taskbar-usage-provider-icon" aria-hidden="true">
                  {definition.iconLabel ?? definition.displayName.slice(0, 2).toUpperCase()}
                </span>
                <strong>{definition.displayName}</strong>
                <span>{snapshot?.routeLabel ?? definition.routes[0]?.label}</span>
              </div>
              <div className="taskbar-usage-registry-metric">{metricLabel(row)}</div>
              {percent !== null && percent !== undefined ? (
                <div
                  className="taskbar-usage-progress"
                  role="progressbar"
                  aria-label={`${definition.displayName} usage`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                >
                  <span style={{ width: `${Math.min(100, percent)}%` }} />
                </div>
              ) : (
                <div className="taskbar-usage-no-quota" aria-hidden="true" />
              )}
              <div className="taskbar-usage-registry-state">
                <span>{snapshot?.connectionState ?? 'disconnected'}</span>
                <span>{definition.usageCapability.replace('_', ' ')}</span>
                <span>{snapshot?.source?.replace('-', ' ') ?? 'unavailable'}</span>
              </div>
              <div className="taskbar-usage-registry-actions">
                <button
                  type="button"
                  onClick={() => {
                    const id = snapshot?.providerId ?? definition.id;
                    onTogglePinned(id, !pinnedProviderIds.includes(id));
                  }}
                  aria-label={`${
                    pinnedProviderIds.includes(snapshot?.providerId ?? definition.id)
                      ? 'Unpin'
                      : 'Pin'
                  } ${definition.displayName}`}
                >
                  {pinnedProviderIds.includes(snapshot?.providerId ?? definition.id) ? (
                    <PinOff aria-hidden="true" />
                  ) : (
                    <Pin aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedProviderId((current) =>
                      current === definition.id ? null : definition.id,
                    )
                  }
                  aria-label={`View ${definition.displayName} diagnostics`}
                >
                  Details
                </button>
                <button
                  type="button"
                  onClick={() => onRefresh(snapshot?.providerId ?? definition.id)}
                  aria-label={`Refresh ${definition.displayName} usage`}
                >
                  <RefreshCw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenConnections(definition.id)}
                  aria-label={`Manage ${definition.displayName} connection`}
                >
                  Manage
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {selected && (
        <aside className="taskbar-usage-diagnostic" aria-label="Provider diagnostics">
          <header>
            <div>
              <strong>{selected.definition.displayName}</strong>
              <span>Sanitized diagnostic preview</span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedProviderId(null)}
              aria-label="Close provider diagnostics"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <pre>{diagnostic}</pre>
          <label className="taskbar-usage-route">
            <span>Connection route</span>
            <select
              aria-label={`Configure ${selected.definition.displayName} route`}
              value={selected.snapshot?.routeId ?? selected.definition.routes[0]?.id ?? ''}
              onChange={() => onOpenConnections(selected.definition.id)}
            >
              {selected.definition.routes.map((route) => (
                <option key={route.id} value={route.id}>
                  {route.label}
                </option>
              ))}
            </select>
            <small>Route changes are completed securely in Provider settings.</small>
          </label>
          <div>
            <button
              type="button"
              onClick={() => onRefresh(selected.snapshot?.providerId ?? selected.definition.id)}
            >
              <RefreshCw aria-hidden="true" />
              Retry
            </button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(diagnostic)}>
              <Clipboard aria-hidden="true" />
              Copy diagnostics
            </button>
            <button type="button" onClick={() => onOpenConnections(selected.definition.id)}>
              <Settings2 aria-hidden="true" />
              Manage connection
            </button>
            {selected.definition.billingUrl && (
              <button
                type="button"
                onClick={() => void openExternal(selected.definition.billingUrl!)}
              >
                <ExternalLink aria-hidden="true" />
                Open billing
              </button>
            )}
          </div>
        </aside>
      )}
    </section>
  );
}
