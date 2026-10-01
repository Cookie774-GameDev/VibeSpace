import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
} from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Cpu, Sparkles, type LucideIcon } from 'lucide-react';
import type { ProviderId } from '@/types';
import { cn } from '@/lib/utils';
import { HiveModelIcon } from '@/components/brand';
import type { ModelPickerGroup } from '@/lib/ai/useAccessibleChatModels';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { scrollPickerItemIntoView } from './pickerScroll';
import { LEGACY_DROPDOWN_TRANSITION, resolveDropdownMotion } from './dropdownMotion';
import { SIK_CONTROL } from '@/lib/jarvis/smoke/evidenceIds';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { getLivePanelUiScale } from '@/lib/ui/panelScale';

/** Sentinel id for the pinned Hive entry (keyboard nav + selection state). */
export const HIVE_OPTION_ID = 'hive:balanced';

const PROVIDER_ICONS: Partial<Record<ProviderId, LucideIcon>> = {
  ollama: Cpu,
  google: Sparkles,
  groq: Sparkles,
  anthropic: Sparkles,
  openai: Sparkles,
  deepseek: Sparkles,
  mock: Sparkles,
};

export interface ModelPickerTypeaheadProps {
  groups: ModelPickerGroup[];
  selectedId: string;
  activeProvider?: ProviderId;
  activeModel?: string;
  /** Whether the Hive ensemble is the active chat selection. */
  hiveActive?: boolean;
  onHoverId?: (id: string) => void;
  onSelect: (
    provider: ProviderId,
    modelId: string,
    connection?: Readonly<ProviderConnection>,
  ) => void;
  /** Select the pinned Hive ensemble entry. When omitted, the row is hidden. */
  onSelectHive?: () => void;
  automaticRoutingEnabled?: boolean;
  onAutomaticRoutingChange?: (enabled: boolean) => void;
  /** Dense sizing for pet mini-panel / narrow composer. */
  compact?: boolean;
}

export interface ModelPickerTypeaheadRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

export const ModelPickerTypeahead = forwardRef<ModelPickerTypeaheadRef, ModelPickerTypeaheadProps>(
  function ModelPickerTypeahead(
    {
      groups,
      selectedId,
      activeProvider,
      activeModel,
      hiveActive,
      onHoverId,
      onSelect,
      onSelectHive,
      automaticRoutingEnabled,
      onAutomaticRoutingChange,
      compact = false,
    },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement>(null);
    const reducedMotion = useReducedMotion();
    const dropdownTransition = useThemeMotionTransition(LEGACY_DROPDOWN_TRANSITION);
    const dropdownMotion = resolveDropdownMotion(reducedMotion, dropdownTransition);
    const panelScale = compact ? getLivePanelUiScale() : 1;

    const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);

    // Navigation order: pinned Hive entry first (when available), then models.
    const navIds = useMemo(() => {
      const usable = flatOptions
        .filter((option) => option.available !== false)
        .map((option) => option.id);
      return onSelectHive ? [HIVE_OPTION_ID, ...usable] : usable;
    }, [flatOptions, onSelectHive]);

    const selectId = (id: string) => {
      if (id === HIVE_OPTION_ID) {
        onSelectHive?.();
        return;
      }
      const option = flatOptions.find((item) => item.id === id);
      if (option && option.available !== false)
        onSelect(option.provider, option.modelId, option.connection);
    };

    useImperativeHandle(ref, () => ({
      moveUp: () => {
        if (navIds.length === 0) return;
        const index = navIds.indexOf(selectedId);
        const next = navIds[(index - 1 + navIds.length) % navIds.length]!;
        onHoverId?.(next);
      },
      moveDown: () => {
        if (navIds.length === 0) return;
        const index = navIds.indexOf(selectedId);
        const next = navIds[(index + 1) % navIds.length]!;
        onHoverId?.(next);
      },
      selectCurrent: () => {
        const id = navIds.includes(selectedId) ? selectedId : navIds[0];
        if (id) selectId(id);
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
        className={cn(
          'jarvis-slash-dropdown overflow-hidden rounded-[14px] border border-border-mid/80',
          compact ? 'w-[min(280px,88vw)] rounded-[10px]' : 'w-[338px]',
          'bg-elevated/95 text-foreground backdrop-blur-xl',
          'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)]',
          '[html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none',
          '[html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none',
        )}
        style={
          compact
            ? ({
                transform: `scale(${panelScale})`,
                transformOrigin: 'bottom left',
              } as CSSProperties)
            : undefined
        }
      >
        <div
          className={cn(
            'border-b border-border bg-panel/90',
            compact ? 'px-2.5 py-1.5' : 'px-4 py-3',
          )}
        >
          <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
            <span
              className={cn(
                'inline-flex items-center justify-center rounded-full border border-accent-copper/55 bg-background/70 shadow-[inset_0_0_10px_hsl(var(--accent-copper)/0.28),0_0_13px_hsl(var(--accent-copper)/0.2)]',
                compact ? 'h-6 w-6' : 'h-8 w-8',
              )}
            >
              <Sparkles className={cn(compact ? 'h-3 w-3' : 'h-4 w-4', 'text-accent-copper')} />
            </span>
            <div className="min-w-0">
              <div
                className={cn(
                  'truncate font-medium text-foreground',
                  compact ? 'text-[13px] leading-4' : 'text-[17px] leading-5',
                )}
              >
                AI model
              </div>
              <div
                className={cn(
                  'text-muted-foreground',
                  compact ? 'text-[10px] leading-3' : 'text-[12px] leading-4',
                )}
              >
                Choose provider and model
              </div>
            </div>
          </div>
        </div>

        <div
          ref={listRef}
          className={cn(
            'overflow-y-auto scrollbar-hidden',
            compact ? 'max-h-[min(200px,42vh)] py-1' : 'max-h-[280px] py-2',
          )}
        >
          {onSelectHive ? (
            <div className="mb-1">
              <div className="px-4 pb-1 pt-0.5 text-[11px] uppercase tracking-[0.2em] text-accent-copper/70">
                Featured
              </div>
              {(() => {
                const isSelected = selectedId === HIVE_OPTION_ID;
                return (
                  <div
                    data-value={HIVE_OPTION_ID}
                    onClick={() => onSelectHive()}
                    onMouseEnter={() => onHoverId?.(HIVE_OPTION_ID)}
                    className={cn(
                      'hive-picker-entry group/hive mx-2 flex cursor-pointer items-center gap-3 rounded-[12px] border px-3 py-2.5 transition-all duration-100',
                      isSelected || hiveActive
                        ? 'border-accent-copper/70 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.05),0_0_20px_hsl(18_84%_30%/0.5)]'
                        : 'border-accent-copper/35 text-foreground hover:border-accent-copper/60',
                    )}
                  >
                    <HiveModelIcon size={22} className="relative shrink-0" />
                    <div className="relative min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium leading-5 text-foreground">
                        Hive
                      </span>
                      <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                        5-model ensemble · balanced for quality
                      </span>
                    </div>
                    {hiveActive && (
                      <span className="relative shrink-0 text-[11px] font-medium text-accent-copper">
                        active
                      </span>
                    )}
                    {isSelected && (
                      <span className="relative shrink-0 text-accent-copper">&gt;</span>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : null}
          {groups.length === 0 ? (
            onSelectHive ? null : (
              <div className="px-4 py-6 text-center">
                <p className="text-[13px] text-muted-foreground">No models available yet.</p>
                <p className="mt-1 text-[12px] leading-4 text-muted-foreground/80">
                  Add an API key, use your subscription, or download a local model in Settings →
                  Local Models.
                </p>
              </div>
            )
          ) : (
            groups.map((group) => {
              const GroupIcon = PROVIDER_ICONS[group.provider] ?? Sparkles;
              return (
                <div key={group.provider}>
                  <div className="px-4 pb-1 pt-0.5 text-[11px] uppercase tracking-[0.2em] text-accent-copper/70">
                    {group.label}
                  </div>
                  {group.options.map((option) => {
                    const isSelected = selectedId === option.id;
                    const isActive =
                      activeProvider === option.provider && activeModel === option.modelId;

                    return (
                      <div
                        key={option.id}
                        data-value={option.id}
                        data-sik-evidence={
                          option.connection?.id === 'vibespace-kernel-smoke-native'
                            ? SIK_CONTROL.modelTransportNative
                            : option.connection?.id === 'vibespace-kernel-smoke-cli'
                              ? SIK_CONTROL.modelTransportCli
                              : undefined
                        }
                        onClick={() =>
                          option.available !== false &&
                          onSelect(option.provider, option.modelId, option.connection)
                        }
                        onMouseEnter={() => option.available !== false && onHoverId?.(option.id)}
                        aria-disabled={option.available === false}
                        className={cn(
                          'mx-2 flex cursor-pointer items-center border',
                          compact
                            ? 'gap-2 rounded-[8px] px-2 py-1.5'
                            : 'gap-3 rounded-[12px] px-3 py-2.5',
                          'transition-all duration-100',
                          option.available === false && 'cursor-not-allowed opacity-55',
                          isSelected
                            ? 'jarvis-slash-item-selected border-accent-copper/60 bg-accent-copper/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]'
                            : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
                        )}
                      >
                        <GroupIcon
                          className={cn(
                            'shrink-0',
                            compact ? 'h-3.5 w-3.5' : 'h-4 w-4',
                            isSelected ? 'text-accent-copper' : 'text-muted-foreground/70',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block truncate font-medium text-foreground',
                              compact ? 'text-[12px] leading-4' : 'text-[15px] leading-5',
                            )}
                          >
                            {option.label}
                          </span>
                          <span
                            className={cn(
                              'block truncate text-muted-foreground',
                              compact ? 'text-[10px] leading-3' : 'text-[11px] leading-4',
                            )}
                          >
                            {option.modeLabel ?? option.modelId}
                            {option.authLabel ? ` · ${option.authLabel}` : ''}
                          </span>
                        </div>
                        {isActive && (
                          <span className="shrink-0 text-[11px] font-medium text-accent-copper">
                            active
                          </span>
                        )}
                        {isSelected && <span className="shrink-0 text-accent-copper">&gt;</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {typeof automaticRoutingEnabled === 'boolean' && onAutomaticRoutingChange ? (
          <button
            type="button"
            role="switch"
            aria-label="Automatic routing"
            aria-checked={automaticRoutingEnabled}
            onClick={() => onAutomaticRoutingChange(!automaticRoutingEnabled)}
            className="flex w-full items-center gap-3 border-t border-border bg-panel/90 px-4 py-2.5 text-left transition-colors hover:bg-muted/70"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-foreground">
                Automatic routing
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Choose an eligible model per request
              </span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                automaticRoutingEnabled
                  ? 'border-accent-copper/60 bg-accent-copper/12 text-accent-copper'
                  : 'border-border text-muted-foreground',
              )}
            >
              {automaticRoutingEnabled ? 'On' : 'Off'}
            </span>
          </button>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border bg-panel/90 px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="jarvis-kbd">up/down</kbd>
            <span>nav</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="jarvis-kbd">enter</kbd>
            <span>select</span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="jarvis-kbd">esc</kbd>
          </span>
        </div>
      </motion.div>
    );
  },
);

export default ModelPickerTypeahead;
