import type { ProviderUsageSnapshot } from './providerUsageTypes';
import { snapshotFreshnessLabel } from './taskbarUsageModel';

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function usageLabel(snapshot: ProviderUsageSnapshot): string {
  if (snapshot.usagePercent !== null) return `${Math.round(snapshot.usagePercent)}%`;
  if (snapshot.usageValue !== null && snapshot.usageUnit) {
    return `${compactNumber(snapshot.usageValue)} ${snapshot.usageUnit}`;
  }
  return 'Quota unavailable';
}

export function ProviderUsageRow({ snapshot }: { snapshot: ProviderUsageSnapshot }) {
  const freshness = snapshotFreshnessLabel(snapshot);
  const resetLabel =
    snapshot.resetAt && snapshot.resetAt > Date.now()
      ? `Resets ${new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
        }).format(snapshot.resetAt)}`
      : null;
  return (
    <div className="taskbar-usage-provider-row" data-testid="taskbar-provider-row">
      <div className="taskbar-usage-provider-copy">
        <span className="taskbar-usage-provider-identity">
          <span className="taskbar-usage-provider-name">{snapshot.displayName}</span>
          {snapshot.routeLabel && (
            <span className="taskbar-usage-provider-route">{snapshot.routeLabel}</span>
          )}
        </span>
        <span className="taskbar-usage-provider-value">{usageLabel(snapshot)}</span>
      </div>
      {snapshot.usagePercent !== null ? (
        <div
          className="taskbar-usage-progress"
          role="progressbar"
          aria-label={`${snapshot.displayName} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(snapshot.usagePercent)}
        >
          <span style={{ width: `${Math.min(100, snapshot.usagePercent)}%` }} />
        </div>
      ) : (
        <div className="taskbar-usage-no-quota" aria-hidden="true" />
      )}
      <div className="taskbar-usage-provider-meta">
        <span>
          {snapshot.activeRequests > 0
            ? `${snapshot.activeRequests} active`
            : (freshness ?? snapshot.connectionState ?? 'Ready')}
        </span>
        {resetLabel && <span>{resetLabel}</span>}
      </div>
    </div>
  );
}
