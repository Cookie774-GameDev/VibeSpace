import { useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { Command } from 'cmdk';
import { cn } from '@/lib/utils';
import { Check, Loader2, AlertCircle, Network, Zap, type LucideIcon } from 'lucide-react';

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

export function SlashCommandOptionPicker({
  commandLabel,
  commandIcon: CommandIcon = Zap,
  options,
  selectedId,
  query,
  loading = false,
  error,
  onHoverId,
  onSelect,
}: SlashCommandOptionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listRef.current || !selectedId) return;
    const selected = listRef.current.querySelector(`[data-value="${selectedId}"]`);
    selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const filteredOptions = query
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(query.toLowerCase()) ||
          o.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={cn(
        'rounded-xl border border-violet-500/30 overflow-hidden',
        'bg-panel/95 backdrop-blur-xl',
        'shadow-[0_8px_32px_rgba(139,92,246,0.15),0_0_0_1px_rgba(139,92,246,0.1)]',
      )}
    >
      <Command
        shouldFilter={false}
        value={selectedId}
        onValueChange={() => {}}
        className="outline-none"
        loop
      >
        <div className="px-3 py-2 border-b border-violet-500/20">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <CommandIcon className="h-3 w-3 text-white" />
            </div>
            <span className="text-secondary">
              <span className="text-violet-400 font-mono">/{commandLabel}</span>
              {query && (
                <span className="text-muted-foreground ml-2">→ {query}</span>
              )}
            </span>
          </div>
        </div>

        <Command.List ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
          {loading ? (
            <div className="px-4 py-8 flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 text-violet-400 animate-spin" />
              <p className="text-secondary text-muted-foreground">Loading options...</p>
            </div>
          ) : error ? (
            <div className="px-4 py-6 flex flex-col items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-red-500/10 flex items-center justify-center">
                <AlertCircle className="h-5 w-5 text-red-400" />
              </div>
              <p className="text-secondary text-red-400">{error}</p>
            </div>
          ) : filteredOptions.length === 0 ? (
            <Command.Empty className="px-4 py-6 text-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-10 w-10 rounded-full bg-violet-500/10 flex items-center justify-center">
                  <Network className="h-5 w-5 text-violet-400" />
                </div>
                {options.length === 0 ? (
                  <>
                    <p className="text-secondary text-muted-foreground">No options available</p>
                    <p className="text-metadata text-muted-foreground/60">
                      Create some first in the relevant page
                    </p>
                  </>
                ) : (
                  <p className="text-secondary text-muted-foreground">
                    No options match <span className="font-mono text-violet-400">{query}</span>
                  </p>
                )}
              </div>
            </Command.Empty>
          ) : (
            filteredOptions.map((option) => {
              const Icon = option.icon ?? Network;
              const isSelected = selectedId === option.id;

              return (
                <Command.Item
                  key={option.id}
                  value={option.id}
                  data-value={option.id}
                  onSelect={() => onSelect(option)}
                  onMouseEnter={() => onHoverId?.(option.id)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg cursor-pointer',
                    'transition-all duration-150',
                    isSelected
                      ? 'bg-gradient-to-r from-violet-500/20 to-purple-600/20 border border-violet-500/30'
                      : 'hover:bg-violet-500/10 border border-transparent',
                  )}
                >
                  <div
                    className={cn(
                      'h-7 w-7 rounded-lg flex items-center justify-center shrink-0 transition-all',
                      isSelected
                        ? 'bg-gradient-to-br from-violet-500 to-purple-600 shadow-[0_0_12px_rgba(139,92,246,0.4)]'
                        : 'bg-violet-500/10',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5', isSelected ? 'text-white' : 'text-violet-400')} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-secondary font-medium',
                        isSelected ? 'text-foreground' : 'text-foreground/90',
                      )}>
                        {option.label}
                      </span>
                      {option.metadata && (
                        <span className="text-metadata text-muted-foreground/60">
                          {option.metadata}
                        </span>
                      )}
                    </div>
                    {option.description && (
                      <p className="text-metadata text-muted-foreground truncate">
                        {option.description}
                      </p>
                    )}
                  </div>
                  {isSelected && (
                    <Check className="h-4 w-4 text-violet-400 shrink-0" />
                  )}
                </Command.Item>
              );
            })
          )}
        </Command.List>

        <div className="px-3 py-2 border-t border-violet-500/20 flex items-center justify-between text-metadata text-muted-foreground/60">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-mono">↵</kbd>
              select
            </span>
          </div>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-mono">esc</kbd>
            close
          </span>
        </div>
      </Command>
    </motion.div>
  );
}

export default SlashCommandOptionPicker;
