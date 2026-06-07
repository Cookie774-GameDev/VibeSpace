import { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Command } from 'cmdk';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  History,
  ListTodo,
  MessageSquare,
  Network,
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
  { cmd: 'contextmap', description: 'Attach a context map to this chat', icon: Network, category: 'action', hasOptions: true },
  { cmd: 'file', description: 'Attach a project file to this chat', icon: FileText, category: 'action', takesArg: true, argPlaceholder: '<filename>' },
  { cmd: 'model', description: 'Switch AI model provider', icon: Zap, category: 'action', takesArg: true, argPlaceholder: '<provider>', hasOptions: true },
  { cmd: 'attach', description: 'Attach a file by absolute path', icon: FileText, category: 'action', takesArg: true, argPlaceholder: '<path>' },
  { cmd: 'clearfiles', description: 'Clear all attached files', icon: FileText, category: 'action' },

  // Navigation
  { cmd: 'terminals', description: 'Open the Terminals page', icon: Terminal, category: 'navigation' },
  { cmd: 'files', description: 'Open the Files page', icon: FileText, category: 'navigation' },
  { cmd: 'kanban', description: 'Open the Kanban board', icon: ListTodo, category: 'navigation' },
  { cmd: 'context', description: 'Open the Context page', icon: Network, category: 'navigation' },
  { cmd: 'history', description: 'Open chat history', icon: History, category: 'navigation' },
  { cmd: 'tools', description: 'Open the Tools page', icon: Wrench, category: 'navigation' },
  { cmd: 'agents', description: 'Open the Agents page', icon: Users, category: 'navigation' },
  { cmd: 'schedule', description: 'Open the Schedule page', icon: CalendarDays, category: 'navigation' },
  { cmd: 'chat', description: 'Return to the Chat canvas', icon: MessageSquare, category: 'navigation' },

  // Utility
  { cmd: 'usage', description: 'Show current provider usage info', icon: BarChart3, category: 'utility' },
  { cmd: 'commands', description: 'Show the full Jarvis command catalog', icon: Zap, category: 'utility' },
  { cmd: 'help', description: 'Show slash command help', icon: HelpCircle, category: 'utility' },
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

export function SlashCommandTypeahead({
  commands,
  selectedCmd,
  query,
  onHoverCmd,
  onSelect,
}: SlashCommandTypeaheadProps) {
  const listRef = useRef<HTMLDivElement>(null);

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
        value={selectedCmd}
        onValueChange={() => {}}
        className="outline-none"
        loop
      >
        <div className="px-3 py-2 border-b border-violet-500/20">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 rounded-md bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <Zap className="h-3 w-3 text-white" />
            </div>
            <span className="text-secondary text-muted-foreground">
              {query ? (
                <>Searching <span className="text-violet-400 font-mono">/{query}</span></>
              ) : (
                'Slash Commands'
              )}
            </span>
          </div>
        </div>

        <Command.List ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {commands.length === 0 ? (
            <Command.Empty className="px-4 py-6 text-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-10 w-10 rounded-full bg-violet-500/10 flex items-center justify-center">
                  <HelpCircle className="h-5 w-5 text-violet-400" />
                </div>
                <p className="text-secondary text-muted-foreground">
                  No commands match <span className="font-mono text-violet-400">/{query}</span>
                </p>
                <p className="text-metadata text-muted-foreground/60">
                  Try /help to see all commands
                </p>
              </div>
            </Command.Empty>
          ) : (
            CATEGORY_ORDER.map((category) => {
              const cmds = groupedCommands[category];
              if (!cmds?.length) return null;
              return (
                <div key={category}>
                  <div className="px-3 py-1.5 text-metadata text-muted-foreground/60 uppercase tracking-wider">
                    {CATEGORY_LABELS[category]}
                  </div>
                  {cmds.map((c) => {
                    const Icon = c.icon;
                    const isSelected = selectedCmd === c.cmd;
                    const label = c.takesArg && c.argPlaceholder
                      ? `/${c.cmd} ${c.argPlaceholder}`
                      : `/${c.cmd}`;

                    return (
                      <Command.Item
                        key={c.cmd}
                        value={c.cmd}
                        data-value={c.cmd}
                        onSelect={() => onSelect(c)}
                        onMouseEnter={() => onHoverCmd?.(c.cmd)}
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
                              'font-mono text-secondary',
                              isSelected ? 'text-violet-300' : 'text-violet-400',
                            )}>
                              {label}
                            </span>
                            {c.hasOptions && (
                              <ChevronRight className="h-3 w-3 text-violet-400/50" />
                            )}
                          </div>
                          <p className="text-metadata text-muted-foreground truncate">
                            {c.description}
                          </p>
                        </div>
                      </Command.Item>
                    );
                  })}
                </div>
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

export default SlashCommandTypeahead;
