import { ChevronDown } from 'lucide-react';
import { HiveModelIcon } from '@/components/brand';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import type { StackPresetId } from '@/lib/ai/stacks/types';
import { benchmarkForPreset } from '@/lib/ai/stacks/benchmark';
import { coerceToExposedPreset } from '@/lib/ai/stacks/presets';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ id: 'off' | 'balanced'; label: string; detail: string }> = [
  { id: 'off', label: 'Single', detail: 'Normal one-model chat' },
  { id: 'balanced', label: 'Hive Balanced', detail: '5-model Balance pipeline' },
];

/** Archived Hive stack control — hidden while the product gate is off. */
export function StackPicker() {
  const hiveEnabled = isHiveProductEnabled();
  const selection = useAuthStore((s) => s.chatModelSelection);
  const setPreset = useAuthStore((s) => s.setStackPreset);
  const activeId = selection.mode === 'hive' ? coerceToExposedPreset(selection.hiveId) : 'off';
  const active = OPTIONS.find((option) => option.id === activeId) ?? OPTIONS[0]!;
  const score = benchmarkForPreset(activeId);

  if (!hiveEnabled) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={activeId === 'off' ? 'ghost' : 'secondary'}
          className={cn(
            'h-7 gap-1.5 rounded-full px-2.5 text-[11px]',
            activeId !== 'off' && 'border-accent-copper/35 bg-accent-copper/10 text-accent-copper',
          )}
        >
          {activeId !== 'off' ? <HiveModelIcon size={21} /> : null}
          {active.label}
          {score?.vibeScore ? <span className="font-mono">{score.vibeScore}</span> : null}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-2">
        <div className="mb-2 px-2">
          <div className="flex items-center gap-2 font-display text-ui-strong text-foreground">
            <HiveModelIcon size={27} />
            Hive mode
          </div>
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
                onClick={() => setPreset(option.id as StackPresetId)}
                className={cn(
                  'w-full rounded-xl border px-3 py-2 text-left transition-colors',
                  option.id === activeId
                    ? 'border-accent-copper/60 bg-accent-copper/10'
                    : 'border-transparent hover:border-border hover:bg-muted/70',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 font-semibold text-foreground">
                    {option.id === 'balanced' ? <HiveModelIcon size={24} /> : null}
                    {option.label}
                  </span>
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
