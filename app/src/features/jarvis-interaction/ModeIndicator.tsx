import * as React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bot, Check, ChevronDown, ClipboardList, HelpCircle, type LucideIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { cn } from '@/lib/utils';
import {
  interactionModeDescription,
  interactionModeLabel,
  PERMISSION_MODE_OPTIONS,
  permissionModeOption,
  type PermissionModeOption,
} from './modes';
import type { JarvisInteractionMode } from './types';

export interface ModeIndicatorProps {
  mode: JarvisInteractionMode;
  compact?: boolean;
  /** Select a specific mode (preferred). */
  onSelectMode?: (mode: JarvisInteractionMode) => void;
  /** Legacy cycle callback (Shift+Tab / simple click fallback). */
  onCycle?: () => void;
}

const MODE_ICONS: Record<JarvisInteractionMode, LucideIcon> = {
  agent: Bot,
  plan: ClipboardList,
  ask: HelpCircle,
};
const SPRING = 'spring' as const;
const OPTION_TRANSITION = { type: SPRING, stiffness: 420, damping: 28 };

const ACCENT: Record<
  PermissionModeOption['accent'],
  { chip: string; icon: string; ring: string; active: string; glow: string }
> = {
  cyan: {
    chip: 'border-accent-cyan/40 bg-accent-cyan/12 text-accent-cyan',
    icon: 'text-accent-cyan',
    ring: 'ring-accent-cyan/35',
    active:
      'border-accent-cyan/55 bg-accent-cyan/15 shadow-[0_0_18px_hsl(var(--accent-cyan)/0.18)]',
    glow: 'from-cyan-400/20 via-sky-500/10 to-transparent',
  },
  copper: {
    chip: 'border-accent-copper/45 bg-accent-copper/12 text-accent-copper',
    icon: 'text-accent-copper',
    ring: 'ring-accent-copper/35',
    active:
      'border-accent-copper/60 bg-accent-copper/15 shadow-[0_0_18px_hsl(var(--accent-copper)/0.2)]',
    glow: 'from-orange-400/20 via-amber-500/10 to-transparent',
  },
  violet: {
    chip: 'border-violet-400/45 bg-violet-500/12 text-violet-300',
    icon: 'text-violet-300',
    ring: 'ring-violet-400/35',
    active: 'border-violet-400/55 bg-violet-500/15 shadow-[0_0_18px_rgba(167,139,250,0.2)]',
    glow: 'from-violet-400/20 via-fuchsia-500/10 to-transparent',
  },
};

export function ModeIndicator({
  mode,
  compact = false,
  onSelectMode,
  onCycle,
}: ModeIndicatorProps) {
  const [open, setOpen] = React.useState(false);
  const optionTransition = useThemeMotionTransition(OPTION_TRANSITION);
  const current = permissionModeOption(mode);
  const Icon = MODE_ICONS[mode];
  const accent = ACCENT[current.accent];

  const pick = (next: JarvisInteractionMode) => {
    if (next === mode) {
      setOpen(false);
      return;
    }
    onSelectMode?.(next);
    if (!onSelectMode) onCycle?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group inline-flex h-7 items-center gap-1 rounded-full border px-1.5 py-0 text-[11px] font-medium leading-none transition-all',
            'hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            accent.chip,
            open && cn('ring-1', accent.ring),
            compact && 'h-6 shrink-0 gap-0.5 whitespace-nowrap px-1.5 text-[10px]',
          )}
          title={`${interactionModeDescription(mode)} Click to change · Shift+Tab cycles · /permissions`}
          aria-label={`${interactionModeLabel(mode)}. Open permissions panel.`}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <Icon className={cn('h-3 w-3 shrink-0', compact && 'h-2.5 w-2.5', accent.icon)} />
          <span className={cn('max-w-[6.5rem] truncate', compact && 'max-w-[4.5rem]')}>
            {interactionModeLabel(mode)}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 opacity-70 transition-transform',
              compact && 'h-2.5 w-2.5',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className={cn(
          'w-[min(320px,92vw)] overflow-hidden rounded-[16px] border border-border-mid/80 p-0',
          'bg-elevated/95 text-foreground backdrop-blur-xl',
          'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_28px_hsl(var(--accent-copper)/0.12)]',
          // Pet mini-panel is z-[81]; default popover z-50 is hidden under it.
          compact && 'z-[120]',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="relative border-b border-border bg-panel/90 px-3.5 py-3">
          <div
            className={cn(
              'pointer-events-none absolute inset-0 bg-gradient-to-br opacity-90',
              accent.glow,
            )}
          />
          <div className="relative flex items-start gap-2.5">
            <span
              className={cn(
                'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border bg-background/70',
                accent.chip,
              )}
            >
              <Icon className={cn('h-4 w-4', accent.icon)} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold tracking-tight text-foreground">Chat mode</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                Agent, Plan, or Ask for this chat. Also:{' '}
                <code className="text-foreground/80">/permissions</code>
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-1 p-2" role="listbox" aria-label="Chat modes">
          <AnimatePresence initial={false}>
            {PERMISSION_MODE_OPTIONS.map((option) => {
              const OptionIcon = MODE_ICONS[option.id];
              const optionAccent = ACCENT[option.accent];
              const selected = option.id === mode;
              return (
                <motion.button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={optionTransition}
                  onClick={() => pick(option.id)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all',
                    'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selected ? optionAccent.active : 'border-transparent bg-transparent',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
                      optionAccent.chip,
                    )}
                  >
                    <OptionIcon className={cn('h-3.5 w-3.5', optionAccent.icon)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-foreground">
                        {option.title}
                      </span>
                      {selected ? (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-background/50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-foreground/80">
                          <Check className="h-2.5 w-2.5" />
                          Active
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>

        <div className="border-t border-border/80 px-3 py-2 text-[10px] text-muted-foreground">
          Tip: <span className="text-foreground/75">Shift+Tab</span> cycles ·{' '}
          <code className="text-foreground/75">/permissions agent</code> ·{' '}
          <code className="text-foreground/75">/permissions plan</code> ·{' '}
          <code className="text-foreground/75">/permissions ask</code>
        </div>
      </PopoverContent>
    </Popover>
  );
}
