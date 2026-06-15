import { ChevronDown, Sparkles } from 'lucide-react';
import type { Part } from '@/types';

type StackStepPart = Extract<Part, { kind: 'stack_step' }>;

export function StackTimeline({ steps }: { steps: StackStepPart[] }) {
  if (steps.length === 0) return null;
  return (
    <details className="group rounded-2xl border border-accent-copper/25 bg-elevated/80 p-3 shadow-soft">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 font-display text-ui-strong text-foreground">
          <Sparkles className="h-4 w-4 text-accent-copper" />
          Hive · {steps.length} steps
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <article key={`${step.step_id}:${index}`} className="rounded-xl border border-border bg-panel/80 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-metadata font-semibold uppercase tracking-[0.16em] text-accent-copper">
                  Step {index + 1} · {step.label}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {step.provider} / {step.model}
                </div>
              </div>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {step.status}
              </span>
            </div>
            {step.text ? (
              <p className="whitespace-pre-wrap text-secondary leading-relaxed text-foreground">
                {step.text}
              </p>
            ) : (
              <p className="text-secondary italic text-muted-foreground">Running…</p>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}

export default StackTimeline;
