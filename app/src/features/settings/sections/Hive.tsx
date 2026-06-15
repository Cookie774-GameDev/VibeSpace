import * as React from 'react';
import { Activity, Plus, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/stores/auth';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';
import type { StackPresetId, StackStepSpec } from '@/lib/ai/stacks/types';
import type { ProviderId } from '@/types';
import { cn } from '@/lib/utils';

const PRESETS: Array<{ id: StackPresetId; label: string; detail: string }> = [
  { id: 'off', label: 'Off', detail: 'Single model chat' },
  { id: 'fast', label: 'Hive Fast', detail: '1 fast pass' },
  { id: 'balanced', label: 'Hive Balanced', detail: 'Draft + check' },
  { id: 'quality', label: 'Hive Quality', detail: 'Opus → GPT-5.5 → Gemini' },
  { id: 'high', label: 'Hive High', detail: 'Grok X High → Opus → Codex → Gemini' },
  { id: 'custom', label: 'Hive Custom', detail: 'Your own model stack' },
];

const PROVIDERS: ProviderId[] = [
  'google',
  'anthropic',
  'openai',
  'deepseek',
  'xai',
  'openrouter',
  'groq',
  'mistral',
  'together',
];

function newStep(index: number): StackStepSpec {
  return {
    id: `custom-${index + 1}`,
    label: `Custom step ${index + 1}`,
    provider: 'google',
    model: 'gemini-3.5-flash',
    temperature: 0.4,
    systemAppend: 'Improve the answer. Return the final answer only.',
  };
}

export function Hive() {
  const stackPreset = useAuthStore((s) => s.stackPreset);
  const stackCustomSteps = useAuthStore((s) => s.stackCustomSteps);
  const setStackPreset = useAuthStore((s) => s.setStackPreset);
  const setStackCustomSteps = useAuthStore((s) => s.setStackCustomSteps);

  const updateStep = (index: number, patch: Partial<StackStepSpec>) => {
    setStackCustomSteps(
      stackCustomSteps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  };

  const removeStep = (index: number) => {
    if (stackCustomSteps.length <= 1) return;
    setStackCustomSteps(stackCustomSteps.filter((_, i) => i !== index));
  };

  return (
    <div className="relative -m-4 space-y-5 overflow-hidden rounded-[28px] bg-[radial-gradient(circle_at_top_left,rgba(217,119,87,0.22),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.16),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.45),transparent)] p-4">
      <header className="relative overflow-hidden rounded-3xl border border-accent-copper/25 bg-slate-950 px-5 py-5 shadow-2xl">
        <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent,rgba(217,119,87,0.12),transparent)]" />
        <div className="relative z-10 flex flex-col gap-2">
          <Badge className="w-fit border-accent-copper/40 bg-accent-copper/10 text-accent-copper">
            <Sparkles className="mr-1 h-3 w-3" /> Chat-only model hive
          </Badge>
          <h2 className="font-display text-page-title text-white">Hive orchestration</h2>
          <p className="max-w-2xl text-secondary leading-relaxed text-slate-300">
            Choose a preset or build a custom sequential stack. Hive applies only to chat
            and never consumes terminal inference paths.
          </p>
        </div>
      </header>

      <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => setStackPreset(preset.id)}
            className={cn(
              'rounded-2xl border bg-panel/80 p-4 text-left shadow-soft transition-all hover:-translate-y-1 hover:border-accent-copper/50',
              stackPreset === preset.id
                ? 'border-accent-copper/70 ring-2 ring-accent-copper/25'
                : 'border-border',
            )}
          >
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent-copper" />
              <span className="font-display text-ui-strong text-foreground">{preset.label}</span>
            </div>
            <p className="mt-2 text-secondary text-muted-foreground">{preset.detail}</p>
          </button>
        ))}
      </section>

      <section className="space-y-3 rounded-3xl border border-border bg-elevated/85 p-4 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-ui-strong text-foreground">Custom Hive steps</h3>
            <p className="text-secondary text-muted-foreground">
              Store provider/model IDs and step prompts only. API keys remain in secure provider settings.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setStackCustomSteps(DEFAULT_CUSTOM_STEPS)}
            >
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setStackCustomSteps([...stackCustomSteps, newStep(stackCustomSteps.length)])}
            >
              <Plus className="h-3.5 w-3.5" /> Add step
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {stackCustomSteps.map((step, index) => (
            <article
              key={`${step.id}:${index}`}
              className="rounded-2xl border border-border bg-panel/80 p-3"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-metadata font-semibold uppercase tracking-[0.16em] text-accent-copper">
                  Step {index + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={stackCustomSteps.length <= 1}
                  onClick={() => removeStep(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-metadata text-muted-foreground">Label</span>
                  <Input
                    value={step.label}
                    onChange={(event) => updateStep(index, { label: event.target.value })}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-metadata text-muted-foreground">Provider</span>
                  <select
                    value={step.provider}
                    onChange={(event) =>
                      updateStep(index, { provider: event.target.value as ProviderId })
                    }
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-body text-foreground"
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-metadata text-muted-foreground">Model ID</span>
                  <Input
                    value={step.model}
                    onChange={(event) => updateStep(index, { model: event.target.value })}
                    placeholder="gemini-3.5-flash"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-metadata text-muted-foreground">Temperature</span>
                  <Input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={step.temperature ?? 0.4}
                    onChange={(event) =>
                      updateStep(index, { temperature: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <label className="mt-3 block space-y-1">
                <span className="text-metadata text-muted-foreground">Step instruction</span>
                <Textarea
                  value={step.systemAppend}
                  onChange={(event) => updateStep(index, { systemAppend: event.target.value })}
                  className="min-h-[92px]"
                />
              </label>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default Hive;
