import { useRef, useEffect, forwardRef, useImperativeHandle, type CSSProperties } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  BrainCircuit,
  CircleDot,
  Cpu,
  Feather,
  Flame,
  Gauge,
  Loader2,
  Network,
  Sparkles,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { scrollPickerItemIntoView } from './pickerScroll';
import { LEGACY_DROPDOWN_TRANSITION, resolveDropdownMotion } from './dropdownMotion';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { useLivePanelUiScale } from '@/lib/ui/panelScale';

export interface SlashCommandOption {
  id: string;
  label: string;
  description?: string;
  metadata?: string;
  icon?: LucideIcon;
  /** Replaces the default Lucide icon (e.g. official plugin logo). */
  leading?: React.ReactNode;
}

export interface SlashCommandOptionPickerProps {
  commandLabel: string;
  commandIcon?: LucideIcon;
  options: SlashCommandOption[];
  selectedId: string;
  query: string;
  loading?: boolean;
  error?: string;
  preview?: React.ReactNode;
  onHoverId?: (id: string) => void;
  onSelect: (option: SlashCommandOption) => void;
  /** Dense sizing for pet mini-panel / narrow composer. */
  compact?: boolean;
}

export interface SlashCommandOptionPickerRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

const EFFORT_ICONS: Record<string, LucideIcon> = {
  auto: CircleDot,
  minimal: Feather,
  low: Gauge,
  medium: BrainCircuit,
  high: Flame,
  ultra: Sparkles,
  max: Cpu,
};

function UltraRoots() {
  return (
    <svg
      data-ultra-roots="true"
      aria-hidden="true"
      viewBox="0 0 300 48"
      preserveAspectRatio="none"
      className="vibespace-ultra-roots pointer-events-none absolute inset-0 h-full w-full"
    >
      <path d="M0 4 C42 4 38 23 92 24 C116 24 123 16 150 24" />
      <path d="M0 44 C34 44 48 28 94 28 C121 28 125 31 150 24" />
      <path d="M0 18 C31 18 47 12 69 26 C91 40 116 31 150 24" />
      <path d="M300 4 C258 4 262 23 208 24 C184 24 177 16 150 24" />
      <path d="M300 44 C266 44 252 28 206 28 C179 28 175 31 150 24" />
      <path d="M300 18 C269 18 253 12 231 26 C209 40 184 31 150 24" />
    </svg>
  );
}

function UltraSigil() {
  return (
    <svg
      data-ultra-sigil="true"
      aria-hidden="true"
      viewBox="0 0 28 28"
      className="vibespace-ultra-sigil h-5 w-5"
    >
      <circle className="vibespace-ultra-sigil-ring" cx="14" cy="14" r="9.5" />
      <path className="vibespace-ultra-sigil-rays" d="M14 1.5v5M14 21.5v5M1.5 14h5M21.5 14h5" />
      <path className="vibespace-ultra-sigil-core" d="M14 7.5 17.2 14 14 20.5 10.8 14Z" />
      <circle className="vibespace-ultra-sigil-star" cx="14" cy="14" r="1.7" />
    </svg>
  );
}

export const SlashCommandOptionPicker = forwardRef<
  SlashCommandOptionPickerRef,
  SlashCommandOptionPickerProps
>(function SlashCommandOptionPicker(
  {
    commandLabel,
    commandIcon: CommandIcon = Zap,
    options,
    selectedId,
    query,
    loading = false,
    error,
    preview,
    onHoverId,
    onSelect,
    compact = false,
  },
  ref,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const dropdownTransition = useThemeMotionTransition(LEGACY_DROPDOWN_TRANSITION);
  const dropdownMotion = resolveDropdownMotion(reducedMotion, dropdownTransition);
  const panelScale = useLivePanelUiScale(compact);
  const compactWidth = compact ? Math.round(220 * panelScale + 60 * (1 - panelScale)) : 338;
  const compactMaxH = compact ? Math.round(160 * panelScale + 40) : 238;
  const titlePx = compact ? Math.max(12, Math.round(17 * panelScale)) : 17;
  const bodyPx = compact ? Math.max(10, Math.round(13 * panelScale)) : 13;
  const labelPx = compact ? Math.max(11, Math.round(15 * panelScale)) : 15;
  const effortPicker = commandLabel.toLowerCase() === 'effort';

  const filteredOptions = query
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(query.toLowerCase()) ||
          option.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : options;
  // The active setting is distinct from the row highlighted for navigation.
  const activeOptionId = options.find((option) => option.metadata === 'active')?.id;

  useImperativeHandle(ref, () => ({
    moveUp: () => {
      if (filteredOptions.length === 0) return;
      const index = filteredOptions.findIndex((option) => option.id === selectedId);
      const next = filteredOptions[(index - 1 + filteredOptions.length) % filteredOptions.length]!;
      onHoverId?.(next.id);
    },
    moveDown: () => {
      if (filteredOptions.length === 0) return;
      const index = filteredOptions.findIndex((option) => option.id === selectedId);
      const next = filteredOptions[(index + 1) % filteredOptions.length]!;
      onHoverId?.(next.id);
    },
    selectCurrent: () => {
      const option = filteredOptions.find((item) => item.id === selectedId) ?? filteredOptions[0];
      if (option) onSelect(option);
    },
  }));

  useEffect(() => {
    if (!listRef.current || !selectedId) return;
    scrollPickerItemIntoView(listRef.current, `[data-value="${selectedId}"]`);
  }, [selectedId]);

  return (
    <motion.div
      {...dropdownMotion}
      data-pet-scaled-picker={compact ? 'true' : undefined}
      data-pet-ui-scale={compact ? String(panelScale) : undefined}
      className={cn(
        'jarvis-slash-dropdown overflow-hidden border border-border-mid/80',
        compact ? 'rounded-[10px]' : 'w-[338px] rounded-[14px]',
        'bg-elevated/95 text-foreground backdrop-blur-xl',
        'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)]',
      )}
      style={
        compact
          ? ({
              width: `${compactWidth}px`,
              maxWidth: 'min(90vw, 280px)',
              ['--pet-ui-scale' as string]: String(panelScale),
            } as CSSProperties)
          : undefined
      }
    >
      <div
        className={cn('border-b border-border bg-panel/90', compact ? 'px-2.5 py-2' : 'px-4 py-3')}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center justify-center rounded-full border border-accent-copper/55 bg-background/70',
              compact ? 'h-6 w-6' : 'h-8 w-8',
              'shadow-[inset_0_0_10px_hsl(var(--accent-copper)/0.28),0_0_13px_hsl(var(--accent-copper)/0.2)]',
            )}
          >
            <CommandIcon className={cn(compact ? 'h-3 w-3' : 'h-4 w-4', 'text-accent-copper')} />
          </span>
          <div className="min-w-0">
            <div
              className="truncate font-medium leading-5 text-foreground"
              style={{ fontSize: `${titlePx}px` }}
            >
              /{commandLabel}
            </div>
            <div
              className="leading-4 text-muted-foreground"
              style={{ fontSize: `${bodyPx - 1}px` }}
            >
              Choose an option
            </div>
          </div>
        </div>
      </div>

      <div
        ref={listRef}
        className={cn('overflow-y-auto scrollbar-hidden', compact ? 'py-1' : 'max-h-[238px] py-2')}
        style={compact ? { maxHeight: `${compactMaxH}px` } : undefined}
      >
        {loading ? (
          <div
            className={cn('flex flex-col items-center gap-2', compact ? 'px-2 py-4' : 'px-4 py-6')}
          >
            <Loader2 className="h-4 w-4 animate-spin text-accent-copper" />
            <span className="text-muted-foreground" style={{ fontSize: `${bodyPx}px` }}>
              Loading...
            </span>
          </div>
        ) : error ? (
          <div
            className={cn('flex flex-col items-center gap-2', compact ? 'px-2 py-3' : 'px-4 py-5')}
          >
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-destructive" style={{ fontSize: `${bodyPx}px` }}>
              {error}
            </span>
          </div>
        ) : filteredOptions.length === 0 ? (
          <div className={cn('text-center', compact ? 'px-2 py-3' : 'px-4 py-5')}>
            <span className="text-muted-foreground" style={{ fontSize: `${bodyPx}px` }}>
              {options.length === 0 ? 'No options available' : `No match for "${query}"`}
            </span>
          </div>
        ) : (
          <div
            role="group"
            aria-label={effortPicker ? 'Live effort options' : `${commandLabel} options`}
          >
            <div
              className={cn(
                'uppercase tracking-[0.2em] text-muted-foreground',
                compact ? 'px-2.5 pb-0.5 pt-0.5 text-[9px]' : 'px-4 pb-1 pt-0.5 text-[11px]',
              )}
            >
              Options
              {query && (
                <span className="ml-1 normal-case tracking-normal text-muted-foreground">
                  -&gt; {query}
                </span>
              )}
            </div>
            {filteredOptions.map((option) => {
              const effortId = option.id.toLowerCase();
              const Icon =
                (effortPicker ? EFFORT_ICONS[effortId] : undefined) ??
                option.icon ??
                (commandLabel === 'terminal' ? Terminal : Network);
              const isSelected = selectedId === option.id;

              return (
                <button
                  key={option.id}
                  type="button"
                  data-value={option.id}
                  data-effort-level={effortPicker ? effortId : undefined}
                  aria-pressed={activeOptionId ? activeOptionId === option.id : isSelected}
                  style={{ width: compact ? 'calc(100% - 0.5rem)' : 'calc(100% - 1rem)' }}
                  onClick={() => onSelect(option)}
                  onMouseEnter={() => onHoverId?.(option.id)}
                  onFocus={() => onHoverId?.(option.id)}
                  className={cn(
                    'relative flex cursor-pointer items-center overflow-hidden border text-left transition-all duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
                    effortPicker && 'vibespace-effort-row capitalize',
                    effortPicker && effortId === 'ultra' && 'vibespace-effort-ultra',
                    compact
                      ? 'mx-1 gap-2 rounded-[8px] px-2 py-1.5'
                      : 'mx-2 gap-3 rounded-[12px] px-3 py-2.5',
                    isSelected
                      ? 'jarvis-slash-item-selected border-accent-copper/60 bg-accent-copper/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]'
                      : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
                  )}
                >
                  {effortPicker && effortId === 'ultra' ? <UltraRoots /> : null}
                  {option.leading ??
                    (effortPicker ? (
                      <span
                        data-effort-icon={effortId}
                        className={cn(
                          'vibespace-effort-glyph relative z-[1] inline-flex shrink-0 items-center justify-center rounded-full border',
                          compact ? 'h-6 w-6' : 'h-7 w-7',
                          isSelected
                            ? 'border-accent-copper/60 bg-accent-copper/15 text-accent-copper'
                            : 'border-border/70 bg-background/35 text-muted-foreground',
                        )}
                      >
                        {effortId === 'ultra' ? (
                          <UltraSigil />
                        ) : (
                          <Icon
                            aria-hidden="true"
                            className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}
                          />
                        )}
                      </span>
                    ) : (
                      <Icon
                        className={cn(
                          'shrink-0',
                          compact ? 'h-3 w-3' : 'h-4 w-4',
                          isSelected ? 'text-accent-copper' : 'text-muted-foreground/70',
                        )}
                      />
                    ))}
                  <div className="relative z-[1] min-w-0 flex-1">
                    <span
                      className="block truncate font-medium leading-5 text-foreground"
                      style={{ fontSize: `${labelPx}px` }}
                    >
                      {option.label}
                    </span>
                    {option.description && (
                      <span
                        className="block whitespace-normal break-words leading-4 text-muted-foreground"
                        style={{ fontSize: `${bodyPx - 1}px` }}
                      >
                        {option.description}
                      </span>
                    )}
                  </div>
                  {option.metadata && (
                    <span
                      className="shrink-0 text-foreground"
                      style={{ fontSize: `${Math.max(9, bodyPx - 2)}px` }}
                    >
                      {option.metadata}
                    </span>
                  )}
                  {isSelected && <span aria-hidden="true" className="shrink-0 text-accent-copper">&gt;</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {preview}

      <div
        className={cn(
          'flex items-center border-t border-border bg-panel/90 text-muted-foreground',
          compact ? 'gap-2 px-2.5 py-1.5 text-[9px]' : 'gap-3 px-4 py-2.5 text-[11px]',
        )}
      >
        <span className="flex items-center gap-1">
          <kbd className="jarvis-kbd !text-foreground">up/down</kbd>
          <span>nav</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="jarvis-kbd !text-foreground">enter</kbd>
          <span>select</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          <kbd className="jarvis-kbd !text-foreground">esc</kbd>
        </span>
      </div>
    </motion.div>
  );
});

export default SlashCommandOptionPicker;
