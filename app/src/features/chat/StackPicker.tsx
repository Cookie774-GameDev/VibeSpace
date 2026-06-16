import { ChevronDown, Sparkles } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import type { StackPresetId } from '@/lib/ai/stacks/types';
import { benchmarkForPreset } from '@/lib/ai/stacks/benchmark';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ id: StackPresetId; label: string; detail: string }> = [
  { id: 'off', label: 'Single', detail: 'Normal one-model chat' },
  { id: 'fast', label: 'Hive Fast', detail: 'Gemini → Opus quick check' },
  { id: 'balanced', label: 'Hive Balanced', detail: 'Grok → Opus → Gemini' },
  { id: 'quality', label: 'Hive Quality', detail: '94.4 simulated VibeScore' },
  { id: 'ultra', label: 'Hive Ultra', detail: '5-step Supernova stack' },
  { id: 'custom', label: 'Hive Custom', detail: 'Your max-5 model stack' },
];

export function StackPicker() {
  const preset = useAuthStore((s) => s.stackPreset);
  const setPreset = useAuthStore((s) => s.setStackPreset);
  const active = OPTIONS.find((option) => option.id === preset) ?? OPTIONS[0]!;
  const score = benchmarkForPreset(preset);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={preset === 'off' ? 'ghost' : 'secondary'}
          className={cn(
            'h-7 gap-1.5 rounded-full px-2.5 text-[11px]',
            preset !== 'off' && 'border-accent-copper/35 bg-accent-copper/10 text-accent-copper',
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {active.label}
          {score?.vibeScore ? <span className="font-mono">{score.vibeScore}</span> : null}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-2">
        <div className="mb-2 px-2">
          <div className="font-display text-ui-strong text-foreground">Hive mode</div>
          <p className="text-metadata text-muted-foreground">
            Chat-only multi-model pipelines. Simulated scores are not live guarantees.
          </p>
        </div>
        <div className="space-y-1">
          {OPTIONS.map((option) => {
            const bench = benchmarkForPreset(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setPreset(option.id)}
                className={cn(
                  'w-full rounded-xl border px-3 py-2 text-left transition-colors',
                  option.id === preset
                    ? 'border-accent-copper/60 bg-accent-copper/10'
                    : 'border-transparent hover:border-border hover:bg-muted/70',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{option.label}</span>
                  {bench?.beatsFable5 ? (
                    <span className="text-[10px] font-semibold text-accent-copper">
                      +{bench.deltaVsFable5} vs Fable
                    </span>
                  ) : null}
                </div>
                <p className="text-metadata text-muted-foreground">{option.detail}</p>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default StackPicker;
