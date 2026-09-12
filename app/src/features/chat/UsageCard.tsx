import { BarChart3 } from 'lucide-react';
import type { UsageSnapshot, UsageValue } from '@/lib/usage/usageTypes';
import { formatUserDateTime } from '@/lib/timeFormat';

function displayValue(value: UsageValue): string {
  if (value.value === undefined) return 'Unavailable';
  if (value.unit === 'usd') return `$${value.value.toFixed(4)}`;
  if (value.unit === 'percent') return `${value.value.toLocaleString()}%`;
  return value.value.toLocaleString();
}

function UsageMetric({ label, value }: { label: string; value: UsageValue }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/35 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-sm text-foreground">{displayValue(value)}</span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        {value.provenance}{value.reason ? ` · ${value.reason}` : ''}
      </p>
    </div>
  );
}

export function UsageCard({ snapshots, scope }: { snapshots: UsageSnapshot[]; scope: 'connection' | 'all' }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-panel/70 p-3" aria-label="Provider usage">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-accent-copper" />
        <div>
          <h3 className="text-sm font-medium text-foreground">{scope === 'all' ? 'All connection usage' : 'Connection usage'}</h3>
          <p className="text-xs text-muted-foreground">Current Jarvis chat only unless a provider-period value says otherwise.</p>
        </div>
      </div>
      {snapshots.map((snapshot) => (
        <article key={snapshot.connectionId} className="space-y-2 border-t border-border/70 pt-3 first:border-0 first:pt-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">{snapshot.providerName}</p>
              <p className="text-xs text-muted-foreground">{snapshot.mode} · {snapshot.authSource}{snapshot.modelId ? ` · ${snapshot.modelId}` : ''}</p>
            </div>
            <time className="text-[10px] text-muted-foreground" dateTime={new Date(snapshot.capturedAt).toISOString()}>
              {formatUserDateTime(snapshot.capturedAt)}
            </time>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <UsageMetric label="Input tokens" value={snapshot.currentChat.inputTokens} />
            <UsageMetric label="Output tokens" value={snapshot.currentChat.outputTokens} />
            <UsageMetric label="Total tokens" value={snapshot.currentChat.totalTokens} />
            <UsageMetric label="Current-chat cost" value={snapshot.currentChat.costUsd} />
            <UsageMetric label="Requests" value={snapshot.currentChat.requests} />
            <UsageMetric label="Subscription quota" value={snapshot.quota} />
          </div>
          {snapshot.note ? <p className="text-xs text-muted-foreground">{snapshot.note}</p> : null}
        </article>
      ))}
    </section>
  );
}
