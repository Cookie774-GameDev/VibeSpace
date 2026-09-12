import * as React from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Clock3,
  Coins,
  Eraser,
  FileCode2,
  Keyboard,
  Loader2,
  MessageSquareText,
  Sparkles,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import './status-dashboard.css';
import {
  clearActiveAccountStatus,
  loadStatusSummary,
  STATUS_ANALYTICS_CHANGED_EVENT,
  type StatusBreakdownRow,
  type StatusPeriod,
  type StatusSummary,
} from './statusAnalytics';

const PERIODS: Array<{ id: StatusPeriod; label: string }> = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
];

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 100_000 ? 'compact' : 'standard',
  }).format(Math.round(value));
}

function formatDuration(value: number): string {
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return value > 0 ? '<1m' : '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function costTruth(summary: StatusSummary): { value: string; note: string } {
  if (summary.costUsd <= 0) return { value: '$0.00', note: 'No metered cost recorded' };
  if (summary.actualCostUsd === summary.costUsd) {
    return { value: `$${summary.costUsd.toFixed(4)}`, note: 'Provider-reported actual' };
  }
  if (summary.estimatedCostUsd === summary.costUsd) {
    return { value: `~$${summary.costUsd.toFixed(4)}`, note: 'Estimated from live pricing' };
  }
  return { value: `$${summary.costUsd.toFixed(4)}`, note: 'Mixed actual and estimated' };
}

export function StatusDashboard({ accountId }: { accountId: string }) {
  const [period, setPeriod] = React.useState<StatusPeriod>('7d');
  const [summary, setSummary] = React.useState<StatusSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const generation = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const operation = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadStatusSummary(accountId, period);
      if (operation === generation.current) setSummary(next);
    } catch {
      if (operation === generation.current) {
        setError('Local status could not be read. Your chats and files were not changed.');
      }
    } finally {
      if (operation === generation.current) setLoading(false);
    }
  }, [accountId, period]);

  React.useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(STATUS_ANALYTICS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(STATUS_ANALYTICS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const clear = async () => {
    await clearActiveAccountStatus();
    setConfirmClear(false);
    await refresh();
  };

  const cost = summary ? costTruth(summary) : { value: '$0.00', note: '' };
  const peak = Math.max(1, ...(summary?.timeline.map((point) => point.activeMs) ?? []));

  return (
    <section className="status-dashboard" aria-labelledby="local-status-heading">
      <div className="status-header">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan">
              <Activity className="h-4 w-4" />
            </span>
            <div>
              <h2 id="local-status-heading" className="font-display text-xl text-foreground">
                Your VibeSpace status
              </h2>
              <p className="text-metadata text-muted-foreground">
                Private, on-device rollups. No prompts, file contents, or keystrokes are stored.
              </p>
            </div>
          </div>
        </div>
        <div className="status-period" aria-label="Status period">
          {PERIODS.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant={period === option.id ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 min-w-12 rounded-lg text-[11px] motion-reduce:transition-none"
              aria-pressed={period === option.id}
              onClick={() => setPeriod(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Reading local
          rollups…
        </div>
      ) : error && !summary ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p>{error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : summary ? (
        <>
          <div className="status-metrics">
            <Metric
              icon={<Clock3 />}
              label="Active time"
              value={formatDuration(summary.activeTimeMs)}
              note="Idle time excluded"
            />
            <Metric
              icon={<Zap />}
              label="AI tokens"
              value={formatNumber(summary.totalTokens)}
              note={`${formatNumber(summary.requests)} exact requests`}
            />
            <Metric icon={<Coins />} label="AI cost" value={cost.value} note={cost.note} />
            <Metric
              icon={<FileCode2 />}
              label="Code changed"
              value={`+${formatNumber(summary.linesAdded)} / −${formatNumber(summary.linesRemoved)}`}
              note={`${formatNumber(summary.aiGeneratedLines)} AI-generated lines`}
            />
          </div>

          <div className="status-overview">
            <div className="status-card">
              <div className="mb-4 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-ui-strong text-foreground">Activity timeline</h3>
                  <p className="text-metadata text-muted-foreground">
                    Active time per interval. Hover or focus a bar for details.
                  </p>
                </div>
                <BarChart3 className="h-4 w-4 text-accent-copper" />
              </div>
              <div className="status-chart" aria-label="Activity over the selected period">
                <div className="status-chart-scale" aria-hidden="true">
                  <span>{formatDuration(peak)}</span>
                  <span>0</span>
                </div>
                <div className="status-chart-plot">
                  {summary.timeline.some((point) => point.activeMs > 0 || point.tokens > 0) ? (
                    summary.timeline.map((point) => {
                      const label = `${new Date(point.timestamp).toLocaleString()}: ${formatDuration(point.activeMs)}, ${formatNumber(point.tokens)} tokens`;
                      return (
                        <div className="status-chart-slot" key={point.timestamp}>
                          <div
                            className="status-chart-bar"
                            role="img"
                            tabIndex={0}
                            aria-label={label}
                            title={label}
                            data-empty={point.activeMs <= 0}
                            style={{ height: `${Math.max(0, (point.activeMs / peak) * 100)}%` }}
                          />
                        </div>
                      );
                    })
                  ) : (
                    <p className="status-empty">Activity will appear as you use VibeSpace.</p>
                  )}
                </div>
              </div>
              {!!summary.timeline.length && (
                <div className="status-chart-dates" aria-hidden="true">
                  <span>
                    {new Date(summary.timeline[0].timestamp).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  {summary.timeline.length > 1 && (
                    <span>
                      {new Date(
                        summary.timeline[summary.timeline.length - 1].timestamp,
                      ).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="status-card">
              <h3 className="text-ui-strong text-foreground">Work facts</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Fact
                  icon={<MessageSquareText />}
                  label="Messages"
                  value={formatNumber(summary.messagesWritten)}
                />
                <Fact
                  icon={<Keyboard />}
                  label="Characters"
                  value={formatNumber(summary.charactersTyped)}
                />
                <Fact icon={<Bot />} label="Completed" value={formatNumber(summary.completed)} />
                <Fact
                  icon={<Zap />}
                  label="Tokens saved"
                  value={formatNumber(summary.tokensSaved)}
                />
              </div>
              {summary.insights.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-border/50 pt-3">
                  {summary.insights.map((insight) => (
                    <p key={insight} className="flex gap-2 text-metadata text-muted-foreground">
                      <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-accent-copper" />
                      {insight}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="status-breakdowns">
            <Breakdown
              title="Where your time went"
              rows={summary.surfaces}
              value={(row) => formatDuration(row.durationMs)}
            />
            <Breakdown
              title="Models used"
              rows={summary.models}
              value={(row) => `${formatNumber(row.totalTokens)} tokens`}
            />
            <Breakdown
              title="Providers"
              rows={summary.providers}
              value={(row) => `${formatNumber(row.requests)} requests`}
            />
            <Breakdown
              title="Projects & agents"
              rows={[...summary.projects, ...summary.agents]}
              value={(row) => `${formatNumber(row.count)} events`}
            />
          </div>

          <div className="status-footer">
            <p className="max-w-2xl text-metadata text-muted-foreground">
              Detailed local events expire automatically; compact rollups remain. Clearing status
              never deletes chats, projects, files, or provider settings.
            </p>
            {confirmClear ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void clear()}>
                  Clear status history
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)}>
                <Eraser className="h-3.5 w-3.5" /> Clear local history
              </Button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactElement;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="status-metric">
      <div className="flex items-center gap-2 text-accent-copper">
        {React.cloneElement(icon, { className: 'h-4 w-4' })}
        <span className="text-metadata font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="status-metric-value">{value}</p>
      <p className="mt-1 text-metadata text-muted-foreground">{note}</p>
    </div>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactElement; label: string; value: string }) {
  return (
    <div className="status-fact">
      <div className="flex items-center gap-1.5 text-metadata text-muted-foreground">
        {React.cloneElement(icon, { className: 'h-3.5 w-3.5' })}
        {label}
      </div>
      <p className="status-fact-value">{value}</p>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  value,
}: {
  title: string;
  rows: StatusBreakdownRow[];
  value: (row: StatusBreakdownRow) => string;
}) {
  return (
    <div className="status-card">
      <h3 className="text-ui-strong text-foreground">{title}</h3>
      <div className="mt-3 space-y-3">
        {rows.length ? (
          rows.slice(0, 6).map((row) => (
            <div key={`${title}-${row.id}`}>
              <div className="flex items-center justify-between gap-3 text-metadata">
                <span className="truncate text-foreground/85" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{value(row)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="status-breakdown-bar"
                  style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }}
                />
              </div>
            </div>
          ))
        ) : (
          <p className="status-empty">No verified activity in this period.</p>
        )}
      </div>
    </div>
  );
}
