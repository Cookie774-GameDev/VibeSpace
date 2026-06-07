import { useMemo } from 'react';
import { Clock, Coins, Database, FileInput, FileOutput, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProviderId } from '@/types/common';

export interface ProviderUsageData {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number | null;
  lastUsed: number | null;
}

interface ProviderUsageCounterProps {
  providerId: ProviderId;
  usage: ProviderUsageData | null;
  className?: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatLastUsed(ts: number | null): string {
  if (!ts) return 'Never';
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function ProviderUsageCounter({ providerId, usage, className }: ProviderUsageCounterProps) {
  const hasUsage = usage && usage.totalTokens > 0;

  const stats = useMemo(() => {
    if (!hasUsage) return null;
    return [
      {
        icon: FileInput,
        label: 'In',
        value: formatTokens(usage.inputTokens),
        color: 'text-accent-copper',
      },
      {
        icon: FileOutput,
        label: 'Out',
        value: formatTokens(usage.outputTokens),
        color: 'text-honey',
      },
      {
        icon: Database,
        label: 'Cached',
        value: formatTokens(usage.cachedTokens),
        color: 'text-sage',
      },
      {
        icon: Sparkles,
        label: 'Total',
        value: formatTokens(usage.totalTokens),
        color: 'text-lavender',
      },
      { icon: Coins, label: 'Cost', value: formatCost(usage.costUsd), color: 'text-rose' },
      {
        icon: Clock,
        label: 'Last',
        value: formatLastUsed(usage.lastUsed),
        color: 'text-muted-foreground',
      },
    ];
  }, [hasUsage, usage]);

  if (!hasUsage) {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 py-1 text-metadata text-muted-foreground/60',
          className,
        )}
        title={`No locally recorded ${providerId} usage this month`}
      >
        <Database className="h-3 w-3" />
        <span>No local usage recorded this month</span>
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-1', className)}
      title={`Locally recorded ${providerId} usage this month`}
    >
      {stats?.map((stat) => (
        <div key={stat.label} className="flex items-center gap-1 text-metadata">
          <stat.icon className={cn('h-3 w-3', stat.color)} />
          <span className="text-muted-foreground/70">{stat.label}:</span>
          <span className={cn('font-medium', stat.color)}>{stat.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ProviderUsageCounterCompact({ usage, className }: ProviderUsageCounterProps) {
  const hasUsage = usage && usage.totalTokens > 0;

  if (!hasUsage) {
    return (
      <span className={cn('text-metadata text-muted-foreground/50', className)}>No usage yet</span>
    );
  }

  return (
    <span className={cn('text-metadata text-muted-foreground/70 font-mono', className)}>
      {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out ·{' '}
      {formatCost(usage.costUsd)}
    </span>
  );
}

export default ProviderUsageCounter;
