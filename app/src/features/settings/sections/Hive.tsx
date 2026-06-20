import * as React from 'react';
import { Activity, Sparkles, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/stores/auth';
import { useAppAdmin } from '@/lib/admin';
import { effectivePlan } from '@/lib/entitlements';
import { coerceToExposedPreset } from '@/lib/ai/stacks/presets';
import type { StackPresetId } from '@/lib/ai/stacks/types';
import { cn } from '@/lib/utils';

/** Plans that may use hosted Hive Balance. Free + BYOK users must supply their own keys. */
const HOSTED_HIVE_PLANS = new Set(['starter', 'pro', 'ultra', 'apex']);

// Only two presets are exposed to users right now.
const PRESETS: Array<{
  id: 'off' | 'balanced';
  label: string;
  detail: string;
  score: string;
  badge: string;
  glow: string;
}> = [
  {
    id: 'off',
    label: 'Off',
    detail: 'Single model chat — no Hive pipeline',
    score: '1×',
    badge: 'Default',
    glow: 'from-slate-500/20 to-slate-700/10',
  },
  {
    id: 'balanced',
    label: 'Hive Balance',
    detail: 'Gemini 3.5 Flash High → MiniMax-M3 → GLM-5.2 → DeepSeek V4 Pro Max → GPT-5.4 mini',
    score: 'Strong',
    badge: 'Flagship',
    glow: 'from-amber-400/20 to-orange-500/10',
  },
];

export function Hive() {
  const storedPreset = useAuthStore((s) => s.stackPreset);
  const currentPlan = useAuthStore((s) => s.plan);
  const admin = useAppAdmin();
  const setStackPreset = useAuthStore((s) => s.setStackPreset);

  // Coerce any legacy stored preset (fast/quality/ultra/custom) to the currently
  // exposed set ('off' | 'balanced') so stale localStorage never breaks the UI.
  const stackPreset: 'off' | 'balanced' = coerceToExposedPreset(storedPreset);

  const activePlan = effectivePlan(currentPlan, admin);
  /** Whether the user has a hosted-Hive-eligible plan. */
  const hasHostedHive = admin || HOSTED_HIVE_PLANS.has(activePlan);

  // If the stored value differs from the coerced value, persist the coercion once.
  React.useEffect(() => {
    if (storedPreset !== stackPreset) {
      setStackPreset(stackPreset as StackPresetId);
    }
  }, [storedPreset, stackPreset, setStackPreset]);

  const handlePresetClick = (id: 'off' | 'balanced') => {
    if (id === 'balanced' && !hasHostedHive) {
      // Dispatch an event so the Plans tab can open (upgrade prompt).
      window.dispatchEvent(
        new CustomEvent('jarvis:settings:tab', { detail: { tab: 'plans' } }),
      );
      return;
    }
    setStackPreset(id);
  };

  return (
    <div className="relative -m-4 space-y-5 overflow-hidden rounded-[28px] bg-[radial-gradient(circle_at_top_left,rgba(217,119,87,0.22),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.16),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.45),transparent)] p-4">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(115deg,transparent,rgba(255,255,255,0.04),transparent)]" />
      <header className="relative overflow-hidden rounded-3xl border border-accent-copper/25 bg-slate-950 px-5 py-5 shadow-2xl">
        <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent,rgba(217,119,87,0.12),transparent)] animate-[plan-border-flow_9s_linear_infinite] bg-[length:220%_auto]" />
        <div className="absolute -right-20 -top-20 h-52 w-52 rounded-full bg-orange-400/20 blur-3xl" />
        <div className="absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-blue-500/15 blur-3xl" />
        <div className="relative z-10 flex flex-col gap-2">
          <Badge className="w-fit border-accent-copper/40 bg-accent-copper/10 text-accent-copper">
            <Sparkles className="mr-1 h-3 w-3" /> Chat-only model hive
          </Badge>
          <h2 className="font-display text-page-title text-white">Hive orchestration</h2>
          <p className="max-w-2xl text-secondary leading-relaxed text-slate-300">
            Route your chat through a sequential multi-model pipeline. Hive applies only to
            chat and never consumes terminal inference paths. BYOK keys are used for each step.
          </p>
        </div>
      </header>

      <section className="relative z-10 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))]">
        {PRESETS.map((preset) => {
          const locked = preset.id === 'balanced' && !hasHostedHive;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetClick(preset.id)}
              aria-label={locked ? `${preset.label} — upgrade to unlock` : preset.label}
              className={cn(
                'group relative overflow-hidden rounded-2xl border bg-panel/80 p-4 text-left shadow-soft transition-all hover:-translate-y-1 hover:border-accent-copper/50 hover:shadow-[0_0_28px_hsl(var(--accent-copper)/0.16)]',
                stackPreset === preset.id && !locked
                  ? 'border-accent-copper/70 ring-2 ring-accent-copper/25'
                  : 'border-border',
                locked && 'opacity-70 cursor-pointer',
              )}
            >
              <div className={cn('absolute inset-0 bg-gradient-to-br opacity-70 transition-opacity group-hover:opacity-100', preset.glow)} />
              {preset.id === 'balanced' && !locked && (
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-amber-300 animate-[plan-border-flow_6s_linear_infinite] bg-[length:220%_auto]" />
              )}
              <div className="relative flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-4 w-4 text-accent-copper" />
                  <span className="font-display text-ui-strong text-foreground">{preset.label}</span>
                </span>
                {locked ? (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden />
                ) : (
                  <span className="rounded-full border border-border bg-background/70 px-2 py-0.5 font-mono text-[10px] text-accent-copper">
                    {preset.score}
                  </span>
                )}
              </div>
              <p className="relative mt-2 text-secondary text-muted-foreground">{preset.detail}</p>
              <p className="relative mt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-copper/80">
                {locked ? 'Paid plan required — tap to upgrade' : preset.badge}
              </p>
            </button>
          );
        })}
      </section>

      {stackPreset === 'balanced' && (
        <section className="relative z-10 rounded-3xl border border-border bg-elevated/85 p-4 shadow-soft">
          <h3 className="font-display text-ui-strong text-foreground mb-1">Hive Balance pipeline</h3>
          <p className="text-secondary text-muted-foreground mb-3">
            5-step ensemble · $4.38 / 1M input · $19.97 / 1M output
          </p>
          <ol className="space-y-1.5 text-secondary text-muted-foreground text-[12px]">
            {[
              ['1', 'Gemini 3.5 Flash High', 'Fast accurate draft'],
              ['2', 'MiniMax-M3', 'Cross-check & reasoning'],
              ['3', 'GLM-5.2', 'Diverse perspective'],
              ['4', 'DeepSeek V4 Pro Max', 'Logic & code hardening'],
              ['5', 'GPT-5.4 mini', 'Final polish'],
            ].map(([num, model, role]) => (
              <li key={num} className="flex items-center gap-2 rounded-xl border border-border/60 bg-panel/60 px-3 py-1.5">
                <span className="font-mono text-accent-copper text-[10px] w-3 shrink-0">{num}</span>
                <span className="font-medium text-foreground/90 min-w-0">{model}</span>
                <span className="text-muted-foreground/60 ml-auto shrink-0">{role}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

export default Hive;
