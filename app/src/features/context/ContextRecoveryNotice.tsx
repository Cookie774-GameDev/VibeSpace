import { AlertTriangle } from 'lucide-react';
import type { ContextRecoverySummary } from './contextRecovery';

export function ContextRecoveryNotice({ recovery }: { recovery: ContextRecoverySummary | null }) {
  if (!recovery) return null;

  return (
    <section
      role="status"
      aria-label="Context recovery options"
      className="space-y-2 rounded-xl border border-accent-honey/40 bg-accent-honey/10 p-3 shadow-soft"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent-honey" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">Context records need recovery</h2>
          <p className="text-metadata text-muted-foreground">
            {recovery.issueCount} {recovery.issueCount === 1 ? 'record needs' : 'records need'}{' '}
            recovery. The original local data remains quarantined and preserved. Recovery actions are not available in this view.
          </p>
        </div>
      </div>
      <ul className="space-y-1.5" aria-label="Recorded recovery options">
        {recovery.options.map((option) => (
          <li key={option.id} className="rounded-lg border border-border bg-paper-soft px-2.5 py-2">
            <div className="text-metadata font-semibold text-foreground">{option.label}</div>
            <div className="text-metadata text-muted-foreground">{option.description}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
