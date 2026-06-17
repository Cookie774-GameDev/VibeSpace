import { ChevronDown, Sparkles } from 'lucide-react';
import type { Part, ProviderId } from '@/types';
import { getProviderDisplayName } from '@/lib/ai/providerRegistry';
import { getModelLabelForProvider } from '@/lib/ai/providerModelCatalog';
import { useProviderConnectionContext } from '@/lib/ai/useProviderModelOptions';

type StackStepPart = Extract<Part, { kind: 'stack_step' }>;

export function StackTimeline({ steps }: { steps: StackStepPart[] }) {
  const ctx = useProviderConnectionContext();
  if (steps.length === 0) return null;
  return (
    <details className="group relative overflow-hidden rounded-2xl border border-accent-copper/25 bg-elevated/80 p-3 shadow-[0_0_34px_hsl(var(--accent-copper)/0.12)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--accent-copper)/0.16),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_40%)]" />
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="relative inline-flex items-center gap-2 font-display text-ui-strong text-foreground">
          <Sparkles className="h-4 w-4 text-accent-copper" />
          Hive · {steps.length} steps
        </span>
        <ChevronDown className="relative h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="relative mt-3 space-y-3">
        {steps.map((step, index) => (
          <article key={`${step.step_id}:${index}`} className="relative overflow-hidden rounded-xl border border-border bg-panel/80 p-3">
            <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-accent-copper via-fuchsia-400 to-blue-400" />
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-metadata font-semibold uppercase tracking-[0.16em] text-accent-copper">
                  Step {index + 1} · {step.label}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {getProviderDisplayName(step.provider)} /{' '}
                  {getModelLabelForProvider(step.provider, step.model, ctx)}
                </div>
              </div>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {step.status}
              </span>
            </div>
            <div className="mb-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              {step.input_tokens != null && <span>{step.input_tokens} in</span>}
              {step.output_tokens != null && <span>{step.output_tokens} out</span>}
              {step.duration_ms != null && <span>{step.duration_ms}ms</span>}
              {step.cost_usd != null && <span>${step.cost_usd.toFixed(4)}</span>}
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
