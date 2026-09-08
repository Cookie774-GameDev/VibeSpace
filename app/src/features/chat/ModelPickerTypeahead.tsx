import { isFastModelRoute } from './runtime/fastRouteSelection';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  BrainCircuit,
  ChevronDown,
  CircleDot,
  Cpu,
  Feather,
  Flame,
  Gauge,
  Search,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
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
import { listEffortOptions, type EffortLabel } from '@/lib/ai/catalog/modelVariants';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import './ModelPickerTypeahead.css';

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

const CATALOG_ROW_SELECTED_STATE =
  'jarvis-slash-item-selected border-accent-copper/60 bg-accent-copper/[0.12] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]';
const CATALOG_ROW_IDLE_STATE =
  'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground';

const EFFORT_ICONS: Record<EffortLabel, LucideIcon> = {
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
      <path d="M19 0 C31 12 50 38 79 33 C105 29 119 22 150 24" />
      <path d="M300 4 C258 4 262 23 208 24 C184 24 177 16 150 24" />
      <path d="M300 44 C266 44 252 28 206 28 C179 28 175 31 150 24" />
      <path d="M300 18 C269 18 253 12 231 26 C209 40 184 31 150 24" />
      <path d="M281 0 C269 12 250 38 221 33 C195 29 181 22 150 24" />
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

function searchableOptionText(option: ModelPickerOption): string {
  return [
    option.label,
    option.modelId,
    option.provider,
    option.modeLabel,
    option.authLabel,
    option.connection?.displayName,
    ...(option.alternativeRoutes ?? []).flatMap((route) => [
      route.label,
      route.modelId,
      route.provider,
      route.connection?.displayName,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

function selectedProviderGroupId(
  groups: readonly ModelPickerGroup[],
  selectedId: string,
): string | undefined {
  const group = groups.find((candidate) =>
    candidate.options.some(
      (option) =>
        option.id === selectedId ||
        option.alternativeRoutes?.some((route) => route.id === selectedId),
    ),
  );
  return group ? (group.id ?? `${group.provider}:${group.label}`) : undefined;
}

export interface ModelPickerTypeaheadProps {
  groups: ModelPickerGroup[];
  selectedId: string;
  /** Saved effort to restore when this exact model supports it. */
  initialEffort?: EffortLabel;
  activeProvider?: ProviderId;
  activeModel?: string;
  /** Whether the Hive ensemble is the active chat selection. */
  hiveActive?: boolean;
  onHoverId?: (id: string) => void;
  onSelect: (
    provider: ProviderId,
    modelId: string,
    connection: Readonly<ProviderConnection> | undefined,
    effort: EffortLabel,
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
  cancelPending: () => void;
}

export const ModelPickerTypeahead = forwardRef<ModelPickerTypeaheadRef, ModelPickerTypeaheadProps>(
  function ModelPickerTypeahead(
    {
      groups,
      selectedId,
      initialEffort = 'auto',
      activeProvider,
      activeModel,
      hiveActive,
      onHoverId,
      onSelect,
      onSelectHive,
      compact = false,
    },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const pickerId = useId();
    const reducedMotion = useReducedMotion();
    const dropdownTransition = useThemeMotionTransition(LEGACY_DROPDOWN_TRANSITION);
    const dropdownMotion = resolveDropdownMotion(reducedMotion, dropdownTransition);
    const panelScale = compact ? getLivePanelUiScale() : 1;
    const [pendingRoutes, setPendingRoutes] = useState<ModelPickerOption | null>(null);
    const [routeIndex, setRouteIndex] = useState(0);
    const [pendingOption, setPendingOption] = useState<ModelPickerOption | null>(null);
    const [effortIndex, setEffortIndex] = useState(0);
    const selectedGroupId = useMemo(
      () => selectedProviderGroupId(groups, selectedId),
      [groups, selectedId],
    );
    const previousSelectionRef = useRef({ selectedId, groupId: selectedGroupId });
    const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
      () => new Set(selectedGroupId ? [selectedGroupId] : []),
    );
    const [searchQuery, setSearchQuery] = useState('');

    const flatOptions = useMemo(() => groups.flatMap((group) => group.options), [groups]);
    const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
    const searchTerms = useMemo(
      () => normalizedSearchQuery.split(/\s+/).filter(Boolean),
      [normalizedSearchQuery],
    );
    const filteredGroups = useMemo(() => {
      if (searchTerms.length === 0) return groups;
      return groups.flatMap((group) => {
        const providerText = `${group.label} ${group.provider}`.toLocaleLowerCase();
        const providerMatches = searchTerms.every((term) => providerText.includes(term));
        const options = providerMatches
          ? group.options
          : group.options.filter((option) =>
              searchTerms.every((term) =>
                `${providerText} ${searchableOptionText(option)}`.includes(term),
              ),
            );
        return options.length > 0 ? [{ ...group, options }] : [];
      });
    }, [groups, searchTerms]);
    const visibleOptions = useMemo(
      () =>
        filteredGroups.flatMap((group) => {
          const groupId = group.id ?? `${group.provider}:${group.label}`;
          return searchTerms.length === 0 && !expandedGroupIds.has(groupId) ? [] : group.options;
        }),
      [expandedGroupIds, filteredGroups, searchTerms.length],
    );
    const exactOptions = useMemo(
      () => flatOptions.flatMap((option) => option.alternativeRoutes ?? [option]),
      [flatOptions],
    );
    const selectedRowId = useMemo(
      () =>
        flatOptions.find((option) =>
          option.alternativeRoutes?.some((route) => route.id === selectedId),
        )?.id ?? selectedId,
      [flatOptions, selectedId],
    );

    // Navigation order: pinned Hive entry first (when available), then models.
    const navIds = useMemo(() => {
      const usable = visibleOptions
        .filter((option) => option.available !== false)
        .map((option) => option.id);
      const hiveMatches = searchTerms.every((term) => `hive ensemble balanced`.includes(term));
      return onSelectHive && hiveMatches ? [HIVE_OPTION_ID, ...usable] : usable;
    }, [onSelectHive, searchTerms, visibleOptions]);

    const toggleGroup = (groupId: string) => {
      setExpandedGroupIds((current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
    };

    useEffect(() => {
      const previous = previousSelectionRef.current;
      previousSelectionRef.current = { selectedId, groupId: selectedGroupId };
      if (
        !selectedGroupId ||
        (previous.selectedId === selectedId && previous.groupId === selectedGroupId)
      ) {
        return;
      }
      setExpandedGroupIds((current) => {
        if (current.has(selectedGroupId)) return current;
        const next = new Set(current);
        next.add(selectedGroupId);
        return next;
      });
    }, [selectedGroupId, selectedId]);

    const effortOptions = useMemo(
      () =>
        listEffortOptions(
          (pendingOption?.variants ?? []).map((id) => ({ id })),
          pendingOption?.modelId,
        ).filter((option) => option.available),
      [pendingOption],
    );
    const committedEffort = effortOptions.some((effort) => effort.label === initialEffort)
      ? initialEffort
      : effortOptions[0]?.label;
    const activeDescendantId = pendingOption
      ? `${pickerId}-effort-${effortOptions[effortIndex]?.label ?? 'none'}`
      : pendingRoutes
        ? `${pickerId}-route-${pendingRoutes.alternativeRoutes?.[routeIndex]?.id ?? 'none'}`
        : selectedRowId === HIVE_OPTION_ID
          ? `${pickerId}-hive`
          : visibleOptions.some((option) => option.id === selectedRowId)
            ? `${pickerId}-model-${selectedRowId}`
            : undefined;

    const beginSelection = (option: ModelPickerOption) => {
      if (option.available === false) return;
      setPendingRoutes(null);
      setPendingOption(option);
      const supported = listEffortOptions(
        (option.variants ?? []).map((id) => ({ id })),
        option.modelId,
      ).filter((candidate) => candidate.available);
      const savedIndex = supported.findIndex((candidate) => candidate.label === initialEffort);
      setEffortIndex(savedIndex >= 0 ? savedIndex : 0);
    };

    const beginLogicalSelection = (option: ModelPickerOption) => {
      const routes = option.alternativeRoutes ?? [];
      if (routes.length <= 1) {
        beginSelection(routes[0] ?? option);
        return;
      }
      const selectedIndex = routes.findIndex(
        (route) => route.id === selectedId && route.available !== false,
      );
      const firstAvailable = routes.findIndex((route) => route.available !== false);
      setRouteIndex(selectedIndex >= 0 ? selectedIndex : Math.max(firstAvailable, 0));
      setPendingRoutes(option);
      setPendingOption(null);
    };

    const commitEffort = (effort: EffortLabel) => {
      if (!pendingOption) return;
      onSelect(pendingOption.provider, pendingOption.modelId, pendingOption.connection, effort);
      setPendingOption(null);
      setEffortIndex(0);
    };

    const selectId = (id: string) => {
      if (id === HIVE_OPTION_ID) {
        onSelectHive?.();
        return;
      }
      const option = exactOptions.find((item) => item.id === id);
      const logicalOption = flatOptions.find((item) => item.id === id);
      if (logicalOption) beginLogicalSelection(logicalOption);
      else if (option) beginSelection(option);
    };

    useImperativeHandle(ref, () => ({
      moveUp: () => {
        if (pendingRoutes) {
          const routes = pendingRoutes.alternativeRoutes ?? [];
          if (routes.length === 0) return;
          setRouteIndex((current) => {
            for (let offset = 1; offset <= routes.length; offset += 1) {
              const next = (current - offset + routes.length) % routes.length;
              if (routes[next]?.available !== false) return next;
            }
            return current;
          });
          return;
        }
        if (pendingOption) {
          setEffortIndex((current) =>
            effortOptions.length === 0
              ? 0
              : (current - 1 + effortOptions.length) % effortOptions.length,
          );
          return;
        }
        if (navIds.length === 0) return;
        const index = navIds.indexOf(selectedRowId);
        const next = navIds[(index - 1 + navIds.length) % navIds.length]!;
        onHoverId?.(next);
      },
      moveDown: () => {
        if (pendingRoutes) {
          const routes = pendingRoutes.alternativeRoutes ?? [];
          if (routes.length === 0) return;
          setRouteIndex((current) => {
            for (let offset = 1; offset <= routes.length; offset += 1) {
              const next = (current + offset) % routes.length;
              if (routes[next]?.available !== false) return next;
            }
            return current;
          });
          return;
        }
        if (pendingOption) {
          setEffortIndex((current) =>
            effortOptions.length === 0 ? 0 : (current + 1) % effortOptions.length,
          );
          return;
        }
        if (navIds.length === 0) return;
        const index = navIds.indexOf(selectedRowId);
        const next = navIds[(index + 1) % navIds.length]!;
        onHoverId?.(next);
      },
      selectCurrent: () => {
        if (pendingRoutes) {
          const route = pendingRoutes.alternativeRoutes?.[routeIndex];
          if (route) beginSelection(route);
          return;
        }
        if (pendingOption) {
          const effort = effortOptions[effortIndex]?.label;
          if (effort) commitEffort(effort);
          return;
        }
        const selectedExactRoute = exactOptions.find((option) => option.id === selectedId);
        const id = navIds.includes(selectedRowId)
          ? (selectedExactRoute?.id ?? selectedRowId)
          : navIds[0];
        if (id) selectId(id);
      },
      cancelPending: () => {
        setPendingRoutes(null);
        setRouteIndex(0);
        setPendingOption(null);
        setEffortIndex(0);
      },
    }));

    useEffect(() => {
      if (!listRef.current || !selectedId) return;
      scrollPickerItemIntoView(listRef.current, `[data-value="${selectedId}"]`);
    }, [selectedId]);

    useEffect(() => {
      const surface = surfaceRef.current;
      const content = surface?.parentElement?.closest<HTMLElement>('[data-state]');
      if (!surface || !content) return;
      const contentHadInert = content.hasAttribute('inert');
      const contentAriaHidden = content.getAttribute('aria-hidden');
      const restoreContentState = () => {
        content.removeAttribute('data-model-picker-exit-closed');
        content.toggleAttribute('inert', contentHadInert);
        if (contentAriaHidden === null) content.removeAttribute('aria-hidden');
        else content.setAttribute('aria-hidden', contentAriaHidden);
      };

      const syncExitState = () => {
        const closed = content.dataset.state === 'closed';
        surface.toggleAttribute('inert', closed);
        if (!closed) {
          surface.removeAttribute('data-exit-closed');
          surface.removeAttribute('aria-hidden');
          restoreContentState();
          return;
        }

        surface.setAttribute('data-exit-closed', 'true');
        surface.setAttribute('aria-hidden', 'true');
        content.setAttribute('data-model-picker-exit-closed', 'true');
        content.setAttribute('inert', '');
        content.setAttribute('aria-hidden', 'true');
        const trigger = Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).find(
          (candidate) => candidate.getAttribute('aria-controls') === content.id,
        );
        trigger?.focus({ preventScroll: true });
      };

      syncExitState();
      const observer = new MutationObserver(syncExitState);
      observer.observe(content, { attributes: true, attributeFilter: ['data-state'] });
      return () => {
        observer.disconnect();
        restoreContentState();
      };
    }, []);

    return (
      <motion.div
        ref={surfaceRef}
        {...dropdownMotion}
        initial={false}
        role="dialog"
        aria-label="Choose AI model"
        data-pet-scaled-picker={compact ? 'true' : undefined}
        className={cn(
          'model-picker-typeahead jarvis-slash-dropdown overflow-hidden rounded-[14px] border border-border-mid/80',
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
            'border-b border-border/60 bg-transparent',
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
                {pendingOption ? 'Choose effort' : pendingRoutes ? 'Choose route' : 'AI model'}
              </div>
              <div
                className={cn(
                  'text-muted-foreground',
                  compact ? 'text-[10px] leading-3' : 'text-[12px] leading-4',
                )}
              >
                {pendingOption
                  ? pendingOption.label
                  : pendingRoutes
                    ? pendingRoutes.label
                    : 'Choose provider and model'}
              </div>
            </div>
          </div>
        </div>

        <div
          ref={listRef}
          id={`${pickerId}-listbox`}
          role="listbox"
          aria-activedescendant={activeDescendantId}
          aria-label={
            pendingOption
              ? `${pendingOption.label} effort options`
              : pendingRoutes
                ? `${pendingRoutes.label} route options`
                : 'Available AI models'
          }
          className={cn(
            'overflow-y-auto scrollbar-hidden',
            compact ? 'max-h-[min(200px,42vh)] py-1' : 'max-h-[280px] py-2',
          )}
        >
          {pendingOption ? (
            <div role="group" aria-label={`${pendingOption.label} effort`} className="py-1">
              {effortOptions.map((effort, index) =>
                (() => {
                  const EffortIcon = EFFORT_ICONS[effort.label];
                  const selected = index === effortIndex;
                  return (
                    <button
                      key={effort.label}
                      type="button"
                      id={`${pickerId}-effort-${effort.label}`}
                      role="option"
                      aria-selected={effort.label === committedEffort}
                      data-effort-level={effort.label}
                      aria-pressed={selected}
                      onMouseEnter={() => setEffortIndex(index)}
                      onClick={() => commitEffort(effort.label)}
                      className={cn(
                        'vibespace-effort-row relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 overflow-hidden rounded-[12px] border px-3 py-2.5 text-left capitalize transition-all duration-150',
                        selected ? CATALOG_ROW_SELECTED_STATE : CATALOG_ROW_IDLE_STATE,
                        effort.label === 'ultra' && 'vibespace-effort-ultra',
                      )}
                    >
                      {effort.label === 'ultra' ? <UltraRoots /> : null}
                      <span
                        data-effort-icon={effort.label}
                        className={cn(
                          'vibespace-effort-glyph relative z-[1] inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                          selected
                            ? 'border-accent-copper/60 bg-accent-copper/15 text-accent-copper'
                            : 'border-border/70 bg-background/35 text-muted-foreground',
                        )}
                      >
                        {effort.label === 'ultra' ? (
                          <UltraSigil />
                        ) : (
                          <EffortIcon aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="relative z-[1] min-w-0 flex-1 font-medium">
                        {effort.upstreamEffort ?? effort.label}
                      </span>
                      {effort.label === 'auto' ? (
                        <span className="relative z-[1] text-[10px] normal-case text-muted-foreground">
                          Provider default
                        </span>
                      ) : null}
                    </button>
                  );
                })(),
              )}
            </div>
          ) : pendingRoutes ? (
            <div role="group" aria-label={`${pendingRoutes.label} routes`} className="py-1">
              {(pendingRoutes.alternativeRoutes ?? []).map((route, index) => {
                const selected = index === routeIndex;
                return (
                  <button
                    key={route.id}
                    type="button"
                    id={`${pickerId}-route-${route.id}`}
                    role="option"
                    data-value={route.id}
                    aria-label={`${route.label} · ${isFastModelRoute(route.modelId) ? 'Fast' : 'Standard'} · ${route.modelId}`}
                    title={route.modelId}
                    data-model-route-fast={isFastModelRoute(route.modelId) || undefined}
                    aria-selected={route.id === selectedId}
                    aria-disabled={route.available === false}
                    aria-pressed={selected}
                    disabled={route.available === false}
                    onMouseEnter={() => route.available !== false && setRouteIndex(index)}
                    onClick={() => beginSelection(route)}
                    className={cn(
                      'mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-[12px] border px-3 py-2.5 text-left transition-all duration-150',
                      route.available === false && 'cursor-not-allowed opacity-55',
                      selected ? CATALOG_ROW_SELECTED_STATE : CATALOG_ROW_IDLE_STATE,
                    )}
                  >
                    <Sparkles
                      aria-hidden="true"
                      className={cn(
                        'h-4 w-4 shrink-0',
                        selected ? 'text-accent-copper' : 'text-muted-foreground/70',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-foreground">
                        {route.label}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {route.modeLabel ? `${route.modeLabel} · ` : ''}
                        {route.modelId}
                        {route.authLabel ? ` · ${route.authLabel}` : ''}
                      </span>
                    </span>
                    <span className="model-route-speed">{isFastModelRoute(route.modelId) ? 'Fast' : 'Standard'}</span>
                  </button>
                );
              })}
            </div>
          ) : onSelectHive &&
            searchTerms.every((term) => `hive ensemble balanced`.includes(term)) ? (
            <div className="mb-1">
              <div className="px-4 pb-1 pt-0.5 text-[11px] uppercase tracking-[0.2em] text-accent-copper/70">
                Featured
              </div>
              {(() => {
                const isSelected = selectedId === HIVE_OPTION_ID;
                return (
                  <div
                    id={`${pickerId}-hive`}
                    data-value={HIVE_OPTION_ID}
                    role="option"
                    aria-selected={hiveActive ?? isSelected}
                    aria-disabled={false}
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
          {!pendingOption && !pendingRoutes && groups.length === 0 ? (
            onSelectHive ? null : (
              <div className="px-4 py-6 text-center">
                <p className="text-[13px] text-muted-foreground">No models available yet.</p>
                <p className="mt-1 text-[12px] leading-4 text-muted-foreground/80">
                  Add an API key, use your subscription, or download a local model in Settings →
                  Local Models.
                </p>
              </div>
            )
          ) : !pendingOption && !pendingRoutes && filteredGroups.length === 0 ? (
            <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
              No matching models.
            </div>
          ) : !pendingOption && !pendingRoutes ? (
            filteredGroups.map((group, groupIndex) => {
              const GroupIcon = PROVIDER_ICONS[group.provider] ?? Sparkles;
              const groupId = group.id ?? `${group.provider}:${group.label}`;
              const isCollapsed = searchTerms.length === 0 && !expandedGroupIds.has(groupId);
              const optionsId = `${pickerId}-provider-${groupIndex}`;
              return (
                <div key={groupId}>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    aria-controls={optionsId}
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.label}`}
                    onClick={() => toggleGroup(groupId)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      event.stopPropagation();
                      toggleGroup(groupId);
                    }}
                    className="flex w-full items-center gap-2 px-4 pb-1 pt-0.5 text-left text-[11px] uppercase tracking-[0.2em] text-accent-copper/70 transition-colors hover:text-accent-copper focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-copper/60"
                  >
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 transition-transform',
                        isCollapsed && '-rotate-90',
                      )}
                    />
                  </button>
                  <div
                    id={optionsId}
                    role="group"
                    aria-label={`${group.label} models`}
                    hidden={isCollapsed}
                  >
                    {!isCollapsed
                      ? group.options.map((option) => {
                          const isSelected =
                            selectedId === option.id ||
                            option.alternativeRoutes?.some((route) => route.id === selectedId) ===
                              true;
                          const isActive =
                            (activeProvider === option.provider &&
                              activeModel === option.modelId) ||
                            option.alternativeRoutes?.some(
                              (route) =>
                                activeProvider === route.provider && activeModel === route.modelId,
                            ) === true;
                          const ariaSelected =
                            activeProvider && activeModel ? isActive : isSelected;

                          return (
                            <div key={option.id}>
                              <div
                                id={`${pickerId}-model-${option.id}`}
                                data-value={option.id}
                                data-model-route-fast={!option.alternativeRoutes && isFastModelRoute(option.modelId) || undefined}
                                role="option"
                                aria-selected={ariaSelected}
                                data-sik-evidence={
                                  option.connection?.id === 'vibespace-kernel-smoke-native'
                                    ? SIK_CONTROL.modelTransportNative
                                    : option.connection?.id === 'vibespace-kernel-smoke-cli'
                                      ? SIK_CONTROL.modelTransportCli
                                      : undefined
                                }
                                onClick={() =>
                                  option.available !== false && beginLogicalSelection(option)
                                }
                                onMouseEnter={() =>
                                  option.available !== false && onHoverId?.(option.id)
                                }
                                aria-disabled={option.available === false}
                                data-model-price={option.pricingStatus ?? 'unknown'}
                                className={cn(
                                  'mx-2 flex cursor-pointer items-center border',
                                  compact
                                    ? 'gap-2 rounded-[8px] px-2 py-1.5'
                                    : 'gap-3 rounded-[12px] px-3 py-2.5',
                                  'transition-all duration-100',
                                  option.available === false && 'cursor-not-allowed opacity-55',
                                  isSelected ? CATALOG_ROW_SELECTED_STATE : CATALOG_ROW_IDLE_STATE,
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
                                {!option.alternativeRoutes && isFastModelRoute(option.modelId) && (
                                  <span className="model-route-speed">Fast</span>
                                )}
                                {isActive && (
                                  <span className="shrink-0 text-[11px] font-medium text-accent-copper">
                                    active
                                  </span>
                                )}
                                {option.isFree && (
                                  <span className="shrink-0 rounded-full border border-emerald-400/45 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                                    Free
                                  </span>
                                )}
                                {isSelected && (
                                  <span className="shrink-0 text-accent-copper">&gt;</span>
                                )}
                              </div>
                            </div>
                          );
                        })
                      : null}
                  </div>
                </div>
              );
            })
          ) : null}
        </div>

        {!pendingOption && !pendingRoutes ? (
          <div
            role="search"
            className={cn(
              'flex items-center gap-2 border-t border-border/40 bg-transparent transition-colors focus-within:border-accent-copper/30',
              compact ? 'px-2.5 py-1.5' : 'px-4 py-2.5',
            )}
          >
            <Search
              aria-hidden="true"
              className={cn('shrink-0 text-muted-foreground', compact ? 'h-3 w-3' : 'h-4 w-4')}
            />
            <input
              type="search"
              value={searchQuery}
              aria-label="Search providers and models"
              aria-controls={`${pickerId}-listbox`}
              aria-expanded={true}
              aria-activedescendant={activeDescendantId}
              placeholder="Search providers or models…"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setSearchQuery(value);
              }}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70',
                compact ? 'text-[10px]' : 'text-[12px]',
              )}
            />
            {searchQuery ? (
              <button
                type="button"
                aria-label="Clear model search"
                onClick={() => setSearchQuery('')}
                className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/60"
              >
                <X aria-hidden="true" className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center gap-3 border-t border-border/60 bg-transparent px-4 py-2.5 text-[11px] text-muted-foreground">
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
