import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Loader2, AlertCircle, Network, Terminal, Zap, type LucideIcon } from 'lucide-react';

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
    onHoverId,
    onSelect,
  },
  ref,
) {
  const listRef = useRef<HTMLDivElement>(null);

  const filteredOptions = query
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(query.toLowerCase()) ||
          option.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

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
        'jarvis-slash-dropdown w-[338px] overflow-hidden rounded-[14px] border border-[#7b4717]/70',
        'bg-[#251d16]/95 text-[#f3eadf] backdrop-blur-xl',
        'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_rgba(255,214,149,0.06),0_0_30px_rgba(234,126,18,0.1)]',
      )}
    >
      <div className="border-b border-[#6d3f16]/55 bg-[#2b2119]/92 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#9b5d19]/70 bg-[#312016] shadow-[inset_0_0_10px_rgba(255,168,38,0.34),0_0_13px_rgba(250,142,14,0.25)]">
            <CommandIcon className="h-4 w-4 text-[#f08a08]" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-medium leading-5 text-[#f3eadf]">
              /{commandLabel}
            </div>
            <div className="text-[12px] leading-4 text-[#cbbba8]">Choose an option</div>
          </div>
        </div>
      </div>

      <div ref={listRef} className="max-h-[238px] overflow-y-auto py-2 scrollbar-hidden">
        {loading ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-[#f08a08]" />
            <span className="text-[13px] text-[#a99682]">Loading...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-5">
            <AlertCircle className="h-4 w-4 text-[#ff7b63]" />
            <span className="text-[13px] text-[#ff9a87]">{error}</span>
          </div>
        ) : filteredOptions.length === 0 ? (
          <div className="px-4 py-5 text-center">
            <span className="text-[13px] text-[#a99682]">
              {options.length === 0 ? 'No options available' : `No match for "${query}"`}
            </span>
          </div>
        ) : (
          <>
            <div className="px-4 pb-1 pt-0.5 text-[11px] uppercase tracking-[0.2em] text-[#b98956]">
              Options
              {query && (
                <span className="ml-1 normal-case tracking-normal text-[#a99682]">
                  -&gt; {query}
                </span>
              )}
            </div>
            {filteredOptions.map((option) => {
              const Icon = option.icon ?? (commandLabel === 'terminal' ? Terminal : Network);
              const isSelected = selectedId === option.id;

              return (
                <div
                  key={option.id}
                  data-value={option.id}
                  onClick={() => onSelect(option)}
                  onMouseEnter={() => onHoverId?.(option.id)}
                  className={cn(
                    'mx-2 flex cursor-pointer items-center gap-3 rounded-[12px] border px-3 py-2.5',
                    'transition-all duration-100',
                    isSelected
                      ? 'jarvis-slash-item-selected border-[#9b5d19]/85 bg-[#3a281a] text-[#f3eadf] shadow-[inset_0_0_0_1px_rgba(255,210,153,0.05),0_0_16px_rgba(240,138,8,0.1)]'
                      : 'border-transparent text-[#cbbba8] hover:border-[#6d3f16]/70 hover:bg-[#30241a] hover:text-[#f3eadf]',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isSelected ? 'text-[#f08a08]' : 'text-[#b98956]',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium leading-5 text-[#f3eadf]">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block truncate text-[12px] leading-4 text-[#a99682]">
                        {option.description}
                      </span>
                    )}
                  </div>
                  {option.metadata && (
                    <span className="shrink-0 text-[11px] text-[#d59b55]">{option.metadata}</span>
                  )}
                  {isSelected && <span className="shrink-0 text-[#f08a08]">&gt;</span>}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-[#6d3f16]/55 bg-[#2b2119]/92 px-4 py-2.5 text-[11px] text-[#a99682]">
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
});

export default SlashCommandOptionPicker;
