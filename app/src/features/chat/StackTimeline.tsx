import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Part } from '@/types';

export interface StackTimelineProps {
  steps: Extract<Part, { kind: 'stack_step' }>[];
  className?: string;
}

function formatCost(usd?: number): string {
  if (usd == null || usd <= 0) return '';
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StepRow({ step }: { step: Extract<Part, { kind: 'stack_step' }> }) {
  const [open, setOpen] = useState(false);
  const meta = [
    `${step.provider}/${step.model}`,
    formatDuration(step.duration_ms),
    formatCost(step.cost_usd),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border border-border/60 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-secondary hover:bg-muted/40 transition-colors"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">{step.label}</span>
        {step.status === 'running' && (
          <span className="ml-1 h-2 w-2 rounded-full bg-accent animate-pulse" aria-label="Running" />
        )}
        <span className="ml-auto text-metadata text-muted-foreground truncate max-w-[55%]">{meta}</span>
      </button>
      {open && step.text && (
        <div className="px-3 pb-2 pt-0.5 text-secondary text-muted-foreground whitespace-pre-wrap break-words border-t border-border/40 max-h-48 overflow-y-auto">
          {step.text}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible step timeline for Vibe Hive multi-model runs.
 */
export function StackTimeline({ steps, className }: StackTimelineProps) {
  if (steps.length === 0) return null;
  return (
    <div className={cn('space-y-1.5 mb-2', className)}>
      <div className="flex items-center gap-1.5 text-metadata text-muted-foreground uppercase tracking-wide">
        <Layers className="h-3.5 w-3.5" />
        <span>Vibe Hive · {steps.length} step{steps.length === 1 ? '' : 's'}</span>
      </div>
      {steps.map((step) => (
        <StepRow key={step.step_id} step={step} />
      ))}
    </div>
  );
}
