import { useState, type ReactNode } from 'react';
import { addDays, addHours, addMinutes, setHours, setMilliseconds, setMinutes, setSeconds } from 'date-fns';
import { Clock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Snooze popover. Five quick options + a custom date/time input.
 *
 * Quick options (per spec section 7):
 *   - 15 min
 *   - 1 hour
 *   - Tonight (today @ 8pm; if already past 8pm, tomorrow 8pm)
 *   - Tomorrow (9am)
 *   - Next week (Mon 9am)
 *
 * The "custom" path uses a native datetime-local input - cheap, predictable,
 * and lets us keep the popover lightweight without a heavy date picker dep.
 */

export interface SnoozePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen target time (unix ms). */
  onSnooze: (until: number) => void;
  /** Anchor used for `now` reference - testable. */
  now?: number;
  /** Optional trigger element. If omitted, an `<aside>` anchor is used (popover anchored externally). */
  children?: ReactNode;
  className?: string;
}

interface QuickOption {
  label: string;
  hint: string;
  resolve: (now: number) => number;
}

const QUICK_OPTIONS: QuickOption[] = [
  {
    label: '15 minutes',
    hint: 'Quick breather',
    resolve: (now) => addMinutes(new Date(now), 15).getTime(),
  },
  {
    label: '1 hour',
    hint: 'After the next thing',
    resolve: (now) => addHours(new Date(now), 1).getTime(),
  },
  {
    label: 'Tonight',
    hint: '8:00 PM',
    resolve: (now) => {
      const d = atTime(new Date(now), 20, 0);
      return d.getTime() > now ? d.getTime() : atTime(addDays(new Date(now), 1), 20, 0).getTime();
    },
  },
  {
    label: 'Tomorrow',
    hint: '9:00 AM',
    resolve: (now) => atTime(addDays(new Date(now), 1), 9, 0).getTime(),
  },
  {
    label: 'Next week',
    hint: 'Monday 9 AM',
    resolve: (now) => {
      const d = new Date(now);
      // Days until Monday: (1 - dow + 7) % 7, force forward
      const offset = ((1 - d.getDay() + 7) % 7) || 7;
      return atTime(addDays(d, offset), 9, 0).getTime();
    },
  },
];

function atTime(d: Date, hh: number, mm: number): Date {
  return setMilliseconds(setSeconds(setMinutes(setHours(d, hh), mm), 0), 0);
}

export function SnoozePopover({ open, onOpenChange, onSnooze, now = Date.now(), children, className }: SnoozePopoverProps) {
  const [custom, setCustom] = useState<string>('');

  const handleQuick = (opt: QuickOption) => {
    onSnooze(opt.resolve(now));
    onOpenChange(false);
  };

  const handleCustom = () => {
    if (!custom) return;
    const ts = new Date(custom).getTime();
    if (Number.isNaN(ts)) return;
    if (ts <= now) return;
    onSnooze(ts);
    onOpenChange(false);
    setCustom('');
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children !== undefined && <PopoverTrigger asChild>{children}</PopoverTrigger>}
      <PopoverContent
        align="end"
        className={cn('w-64 p-2', className)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5 text-metadata text-muted-foreground">
          <Clock className="h-3 w-3" />
          Snooze until
        </div>
        <div className="flex flex-col">
          {QUICK_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-body hover:bg-muted/70 transition-colors"
              onClick={() => handleQuick(opt)}
            >
              <span className="text-foreground">{opt.label}</span>
              <span className="text-metadata text-muted-foreground">{opt.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 border-t border-border pt-2">
          <label className="block px-1 pb-1 text-metadata text-muted-foreground">Custom</label>
          <div className="flex gap-1.5 px-1">
            <Input
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="h-7 flex-1 text-secondary"
            />
            <Button size="sm" variant="secondary" onClick={handleCustom} disabled={!custom}>
              Set
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
