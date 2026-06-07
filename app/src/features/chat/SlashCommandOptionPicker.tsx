import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Check, Loader2, AlertCircle, Network, Terminal, Zap, type LucideIcon } from 'lucide-react';

export interface SlashCommandOption {
  id: string;
  label: string;
  description?: string;
  metadata?: string;
  icon?: LucideIcon;
}

export interface SlashCommandOptionPickerProps {
  commandLabel: string;
  commandIcon?: LucideIcon;
  options: SlashCommandOption[];
  selectedId: string;
  query: string;
  loading?: boolean;
  error?: string;
  onHoverId?: (id: string) => void;
  onSelect: (option: SlashCommandOption) => void;
}

export interface SlashCommandOptionPickerRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

export const SlashCommandOptionPicker = forwardRef<SlashCommandOptionPickerRef, SlashCommandOptionPickerProps>(
  function SlashCommandOptionPicker(
    {
      commandLabel,
      commandIcon: CommandIcon = Zap,
      options,
      selectedId,
      query,
      loading = false,
      error,
      onHoverId,
      onSelect,
    },
    ref,
  ) {
    const listRef = useRef<HTMLDivElement>(null);

    const filteredOptions = query
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(query.toLowerCase()) ||
            o.description?.toLowerCase().includes(query.toLowerCase()),
        )
      : options;

    useImperativeHandle(ref, () => ({
      moveUp: () => {
        if (filteredOptions.length === 0) return;
        const i = filteredOptions.findIndex((o) => o.id === selectedId);
        const next = filteredOptions[(i - 1 + filteredOptions.length) % filteredOptions.length]!;
        onHoverId?.(next.id);
      },
      moveDown: () => {
        if (filteredOptions.length === 0) return;
        const i = filteredOptions.findIndex((o) => o.id === selectedId);
        const next = filteredOptions[(i + 1) % filteredOptions.length]!;
        onHoverId?.(next.id);
      },
      selectCurrent: () => {
        const option = filteredOptions.find((o) => o.id === selectedId) ?? filteredOptions[0];
        if (option) onSelect(option);
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
          'w-[240px] rounded-lg border border-violet-500/40 overflow-hidden',
          'bg-[#1a1625]/98 backdrop-blur-lg',
          'shadow-[0_4px_20px_rgba(139,92,246,0.2)]',
          'font-mono text-[11px]',
        )}
      >
        {/* Header */}
        <div className="px-2 py-1.5 border-b border-violet-500/20 bg-violet-500/5">
          <div className="flex items-center gap-1.5">
            <CommandIcon className="h-3 w-3 text-violet-400" />
            <span className="text-violet-300/80 text-[10px]">
              /{commandLabel}
              {query && <span className="text-violet-500/60 ml-1">→ {query}</span>}
            </span>
          </div>
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-[180px] overflow-y-auto py-0.5 scrollbar-hidden">
          {loading ? (
            <div className="px-2 py-4 flex flex-col items-center gap-2">
              <Loader2 className="h-4 w-4 text-violet-400 animate-spin" />
              <span className="text-violet-400/60 text-[10px]">Loading...</span>
            </div>
          ) : error ? (
            <div className="px-2 py-3 flex flex-col items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-400" />
              <span className="text-red-400/80 text-[10px]">{error}</span>
            </div>
          ) : filteredOptions.length === 0 ? (
            <div className="px-2 py-3 text-center">
              {options.length === 0 ? (
                <span className="text-violet-400/60 text-[10px]">No options available</span>
              ) : (
                <span className="text-violet-400/60 text-[10px]">No match for "{query}"</span>
              )}
            </div>
          ) : (
            filteredOptions.map((option) => {
              const Icon = option.icon ?? (commandLabel === 'terminal' ? Terminal : Network);
              const isSelected = selectedId === option.id;

              return (
                <div
                  key={option.id}
                  data-value={option.id}
                  onClick={() => onSelect(option)}
                  onMouseEnter={() => onHoverId?.(option.id)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 mx-0.5 rounded cursor-pointer',
                    'transition-all duration-100',
                    isSelected
                      ? 'bg-violet-500/25 text-violet-200'
                      : 'text-violet-300/70 hover:bg-violet-500/10 hover:text-violet-200',
                  )}
                >
                  <Icon className={cn(
                    'h-3 w-3 shrink-0',
                    isSelected ? 'text-violet-400' : 'text-violet-500/50',
                  )} />
                  <div className="flex-1 min-w-0">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-[9px] text-violet-500/50">
                        {option.description}
                      </span>
                    )}
                  </div>
                  {option.metadata && (
                    <span className="text-[9px] text-violet-500/40 shrink-0">
                      {option.metadata}
                    </span>
                  )}
                  {isSelected && (
                    <Check className="h-3 w-3 text-violet-400 shrink-0" />
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-2 py-1 border-t border-violet-500/20 bg-violet-500/5 flex items-center gap-2 text-[9px] text-violet-500/50">
          <span><kbd className="text-violet-400">↑↓</kbd> nav</span>
          <span><kbd className="text-violet-400">↵</kbd> select</span>
          <span className="ml-auto"><kbd className="text-violet-400">esc</kbd></span>
        </div>
      </motion.div>
    );
  },
);

export default SlashCommandOptionPicker;
