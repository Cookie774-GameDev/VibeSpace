import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  FileText,
  HelpCircle,
  History,
  ListTodo,
  MessageSquare,
  Network,
  Plug,
  Settings,
  Terminal,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export interface SlashCommandDef {
  cmd: string;
  description: string;
  icon: LucideIcon;
  category?: 'navigation' | 'action' | 'utility';
  takesArg?: boolean;
  argPlaceholder?: string;
  hasOptions?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // Actions
  {
    cmd: 'contextmap',
    description: 'Attach a context map',
    icon: Network,
    category: 'action',
    hasOptions: true,
  },
  {
    cmd: 'terminal',
    description: 'Attach a terminal',
    icon: Terminal,
    category: 'action',
    hasOptions: true,
  },
  {
    cmd: 'plug',
    description: 'Attach a connected plugin',
    icon: Plug,
    category: 'action',
    hasOptions: true,
  },
  {
    cmd: 'file',
    description: 'Attach a project file',
    icon: FileText,
    category: 'action',
    takesArg: true,
    argPlaceholder: '<filename>',
  },
  {
    cmd: 'model',
    description: 'Switch AI model',
    icon: Zap,
    category: 'action',
    takesArg: true,
    argPlaceholder: '<provider>',
    hasOptions: true,
  },
  {
    cmd: 'attach',
    description: 'Attach by path',
    icon: FileText,
    category: 'action',
    takesArg: true,
    argPlaceholder: '<path>',
  },
  { cmd: 'clearfiles', description: 'Clear attachments', icon: FileText, category: 'action' },

  // Navigation
  { cmd: 'terminals', description: 'Open Terminals', icon: Terminal, category: 'navigation' },
  { cmd: 'files', description: 'Open Files', icon: FileText, category: 'navigation' },
  { cmd: 'kanban', description: 'Open Kanban', icon: ListTodo, category: 'navigation' },
  { cmd: 'context', description: 'Open Context', icon: Network, category: 'navigation' },
  { cmd: 'history', description: 'Open History', icon: History, category: 'navigation' },
  { cmd: 'tools', description: 'Open Tools', icon: Wrench, category: 'navigation' },
  { cmd: 'agents', description: 'Open Agents', icon: Users, category: 'navigation' },
  { cmd: 'schedule', description: 'Open Schedule', icon: CalendarDays, category: 'navigation' },
  { cmd: 'chat', description: 'Back to Chat', icon: MessageSquare, category: 'navigation' },

  // Utility
  { cmd: 'usage', description: 'Show usage info', icon: BarChart3, category: 'utility' },
  { cmd: 'commands', description: 'Command catalog', icon: Zap, category: 'utility' },
  { cmd: 'help', description: 'Show help', icon: HelpCircle, category: 'utility' },
];

const CATEGORY_LABELS: Record<string, string> = {
  action: 'Actions',
  navigation: 'Navigation',
  utility: 'Utility',
};

const CATEGORY_ORDER = ['action', 'navigation', 'utility'];

export interface SlashCommandTypeaheadProps {
  commands: SlashCommandDef[];
  selectedCmd: string;
  query: string;
  onHoverCmd?: (cmd: string) => void;
  onSelect: (cmd: SlashCommandDef) => void;
}

export interface SlashCommandTypeaheadRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

export const SlashCommandTypeahead = forwardRef<
  SlashCommandTypeaheadRef,
  SlashCommandTypeaheadProps
>(function SlashCommandTypeahead({ commands, selectedCmd, query, onHoverCmd, onSelect }, ref) {
  const listRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    moveUp: () => {
      if (commands.length === 0) return;
      const i = commands.findIndex((c) => c.cmd === selectedCmd);
      const next = commands[(i - 1 + commands.length) % commands.length]!;
      onHoverCmd?.(next.cmd);
    },
    moveDown: () => {
      if (commands.length === 0) return;
      const i = commands.findIndex((c) => c.cmd === selectedCmd);
      const next = commands[(i + 1) % commands.length]!;
      onHoverCmd?.(next.cmd);
    },
    selectCurrent: () => {
      const cmd = commands.find((c) => c.cmd === selectedCmd) ?? commands[0];
      if (cmd) onSelect(cmd);
    },
  }));

  useEffect(() => {
    if (!listRef.current || !selectedCmd) return;
    const selected = listRef.current.querySelector(`[data-value="${selectedCmd}"]`);
    selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedCmd]);

  const groupedCommands = commands.reduce<Record<string, SlashCommandDef[]>>((acc, cmd) => {
    const cat = cmd.category ?? 'utility';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(cmd);
    return acc;
  }, {});

  return (
    <motion.div
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cn(
        'jarvis-slash-dropdown w-[276px] overflow-hidden rounded-[12px] border border-border-mid/80',
        'bg-elevated/95 text-foreground backdrop-blur-xl',
        'shadow-[0_18px_48px_rgba(0,0,0,0.48),inset_0_1px_0_hsl(var(--foreground)/0.05)]',
        'font-mono text-[11px]',
      )}
    >
      {/* Header */}
      <div className="border-b border-border bg-panel/90 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-accent-copper" />
          <span className="text-[10px] text-muted-foreground">
            {query ? `/${query}` : 'commands'}
          </span>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} className="max-h-[200px] overflow-y-auto py-0.5 scrollbar-hidden">
        {commands.length === 0 ? (
          <div className="px-2 py-3 text-center text-[10px] text-muted-foreground">
            No match for /{query}
          </div>
        ) : (
          CATEGORY_ORDER.map((category) => {
            const cmds = groupedCommands[category];
            if (!cmds?.length) return null;
            return (
              <div key={category}>
                <div className="px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-accent-copper/65">
                  {CATEGORY_LABELS[category]}
                </div>
                {cmds.map((c) => {
                  const Icon = c.icon;
                  const isSelected = selectedCmd === c.cmd;

                  return (
                    <div
                      key={c.cmd}
                      data-value={c.cmd}
                      onClick={() => onSelect(c)}
                      onMouseEnter={() => onHoverCmd?.(c.cmd)}
                      className={cn(
                        'mx-1 flex cursor-pointer items-center gap-2 rounded-[7px] border px-2.5 py-1.5',
                        'transition-all duration-100',
                        isSelected
                          ? 'jarvis-slash-item-selected border-accent-copper/45 bg-accent-copper/12 text-foreground'
                          : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-3 w-3 shrink-0',
                          isSelected ? 'text-accent-copper' : 'text-muted-foreground/70',
                        )}
                      />
                      <span className="flex-1 truncate">/{c.cmd}</span>
                      {c.hasOptions && (
                        <ChevronRight className="h-2.5 w-2.5 text-accent-copper/60" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-border bg-panel/90 px-3 py-1.5 text-[9px] text-muted-foreground">
        <span>
          <kbd className="jarvis-kbd">up/down</kbd> nav
        </span>
        <span>
          <kbd className="jarvis-kbd">enter</kbd> select
        </span>
        <span className="ml-auto">
          <kbd className="jarvis-kbd">esc</kbd>
        </span>
      </div>
    </motion.div>
  );
});

export default SlashCommandTypeahead;
