import { useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import { browserTokenOptimizationPreferences } from './browserPreferences';
import { TOKEN_OPTIMIZATION_MODES, type TokenOptimizationMode } from './contracts';

const LABELS: Readonly<Record<TokenOptimizationMode, string>> = {
  off: 'Off',
  saver: 'Saver',
  normal: 'Normal',
  final_boss: 'Final Boss',
};

export function TokenOptimizationChatControl({
  chatKey,
  compact = false,
}: {
  chatKey: string;
  compact?: boolean;
}) {
  const preferences = useSyncExternalStore(
    browserTokenOptimizationPreferences.subscribe,
    browserTokenOptimizationPreferences.getSnapshot,
    browserTokenOptimizationPreferences.getSnapshot,
  );
  const override = preferences.chatOverrides[chatKey] ?? null;
  const effective = override ?? preferences.globalMode;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            'h-7 gap-0.5 px-1.5 text-muted-foreground',
            compact && 'h-6 shrink-0 px-1 text-[10px] leading-none',
          )}
          aria-label={`Token Optimize: ${LABELS[effective]}`}
        >
          <span className={cn('text-metadata leading-none', compact && 'text-[10px]')}>
            {compact ? `Tok: ${LABELS[effective]}` : `Token: ${LABELS[effective]}`}
          </span>
          <ChevronDown
            className={cn('h-3.5 w-3.5', compact && 'h-3 w-3')}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-2">
        <p className="px-2 pb-2 text-metadata text-muted-foreground">
          This chat only. The selected model stays fixed.
        </p>
        <button
          type="button"
          className="w-full rounded-md px-2 py-2 text-left text-secondary hover:bg-muted"
          aria-pressed={override === null}
          onClick={() => browserTokenOptimizationPreferences.setChatOverride(chatKey, null)}
        >
          Inherit global · {LABELS[preferences.globalMode]}
        </button>
        {TOKEN_OPTIMIZATION_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="w-full rounded-md px-2 py-2 text-left text-secondary hover:bg-muted aria-pressed:bg-accent-cyan/10"
            aria-pressed={override === mode}
            onClick={() => browserTokenOptimizationPreferences.setChatOverride(chatKey, mode)}
          >
            {LABELS[mode]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
