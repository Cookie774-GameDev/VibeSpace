import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { Cpu, Sparkles, type LucideIcon } from 'lucide-react';
import type { ProviderId } from '@/types';
import { cn } from '@/lib/utils';
import type { ModelPickerGroup } from '@/lib/ai/useAccessibleChatModels';

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
  onHoverId?: (id: string) => void;
  onSelect: (provider: ProviderId, modelId: string) => void;
}

export interface ModelPickerTypeaheadRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

export const ModelPickerTypeahead = forwardRef<ModelPickerTypeaheadRef, ModelPickerTypeaheadProps>(
  function ModelPickerTypeahead(
    { groups, selectedId, activeProvider, activeModel, onHoverId, onSelect },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement>(null);

    const flatOptions = useMemo(
      () => groups.flatMap((group) => group.options),
      [groups],
    );

    useImperativeHandle(ref, () => ({
      moveUp: () => {
        if (flatOptions.length === 0) return;
        const index = flatOptions.findIndex((option) => option.id === selectedId);
        const next = flatOptions[(index - 1 + flatOptions.length) % flatOptions.length]!;
        onHoverId?.(next.id);
      },
      moveDown: () => {
        if (flatOptions.length === 0) return;
        const index = flatOptions.findIndex((option) => option.id === selectedId);
        const next = flatOptions[(index + 1) % flatOptions.length]!;
        onHoverId?.(next.id);
      },
      selectCurrent: () => {
        const option =
          flatOptions.find((item) => item.id === selectedId) ?? flatOptions[0];
        if (option) onSelect(option.provider, option.modelId);
      },
    }));

    useEffect(() => {
      if (!listRef.current || !selectedId) return;
      const selected = listRef.current.querySelector(`[data-value="${selectedId}"]`);
      selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedId]);

    return (
      <motion.div
        initial={{ opacity: 0, y: 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        className={cn(
          'jarvis-slash-dropdown w-[338px] overflow-hidden rounded-[14px] border border-border-mid/80',
          'bg-elevated/95 text-foreground backdrop-blur-xl',
          'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)]',
        )}
      >
        <div className="border-b border-border bg-panel/90 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-accent-copper/55 bg-background/70 shadow-[inset_0_0_10px_hsl(var(--accent-copper)/0.28),0_0_13px_hsl(var(--accent-copper)/0.2)]">
              <Sparkles className="h-4 w-4 text-accent-copper" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[17px] font-medium leading-5 text-foreground">
                AI model
              </div>
              <div className="text-[12px] leading-4 text-muted-foreground">
                Choose provider and model
              </div>
            </div>
          </div>
        </div>

        <div ref={listRef} className="max-h-[280px] overflow-y-auto py-2 scrollbar-hidden">
          {groups.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-[13px] text-muted-foreground">
                No models available yet.
              </p>
              <p className="mt-1 text-[12px] leading-4 text-muted-foreground/80">
                Add an API key, use your subscription, or download a local model in Settings →
                Local Models.
              </p>
            </div>
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
                        onClick={() => onSelect(option.provider, option.modelId)}
                        onMouseEnter={() => onHoverId?.(option.id)}
                        className={cn(
                          'mx-2 flex cursor-pointer items-center gap-3 rounded-[12px] border px-3 py-2.5',
                          'transition-all duration-100',
                          isSelected
                            ? 'jarvis-slash-item-selected border-accent-copper/60 bg-accent-copper/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]'
                            : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
                        )}
                      >
                        <GroupIcon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            isSelected ? 'text-accent-copper' : 'text-muted-foreground/70',
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-medium leading-5 text-foreground">
                            {option.label}
                          </span>
                          <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">
                            {option.modelId}
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
