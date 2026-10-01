import { useRef, useEffect, forwardRef, useImperativeHandle, type CSSProperties } from 'react';
import { useLivePanelUiScale } from '@/lib/ui/panelScale';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { HiveModelIcon } from '@/components/brand';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import { scrollPickerItemIntoView } from './pickerScroll';
import { LEGACY_DROPDOWN_TRANSITION, resolveDropdownMotion } from './dropdownMotion';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { SLASH_COMMAND_ALIASES, normalizeSlashCommand } from './slashCommandRouting';
import {
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Gauge,
  FileText,
  HelpCircle,
  History,
  ListTodo,
  MessageSquare,
  Network,
  Palette,
  Plug,
  Redo2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Undo2,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export interface SlashCommandDef {
  cmd: string;
  /** Optional owner-facing label for commands whose canonical parser token is shorter. */
  label?: string;
  /** Exact command text shown in the picker. */
  displayCommand?: string;
  /** Legacy spellings that resolve to this command (e.g. terminal → terminals). */
  aliases?: string[];
  description: string;
  icon: LucideIcon;
  /** Official Hive model mark instead of Lucide icon. */
  brandIcon?: 'hive';
  category?: 'chat' | 'navigation' | 'utility';
  takesArg?: boolean;
  argPlaceholder?: string;
  hasOptions?: boolean;
}

export const SLASH_CMD_ALIASES: Readonly<Record<string, string>> = SLASH_COMMAND_ALIASES;

export function normalizeSlashCmd(raw: string): string {
  return normalizeSlashCommand(raw);
}

export const CHAT_ATTACH_SLASH_CMDS = new Set([
  'context',
  'plug',
  'skills',
  'allaboutme',
  'file',
  'canvas',
]);

export function isChatAttachSlashCmd(cmd: string): boolean {
  return CHAT_ATTACH_SLASH_CMDS.has(normalizeSlashCmd(cmd));
}

export function findSlashCommandDef(cmd: string): SlashCommandDef | undefined {
  const canonical = normalizeSlashCmd(cmd);
  const def = SLASH_COMMANDS.find((entry) => entry.cmd === canonical);
  // Hive slash is archived in the full table but hidden while the product is gated.
  if (def?.cmd === 'hive' && !isHiveProductEnabled()) return undefined;
  return def;
}

/** Slash commands visible in product typeahead / search (Hive filtered when gated). */
export function getVisibleSlashCommands(): SlashCommandDef[] {
  if (isHiveProductEnabled()) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((entry) => entry.cmd !== 'hive');
}

function fuzzyTokenScore(query: string, target: string): number {
  const t = target.toLowerCase();
  if (!query) return 1;
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  if (t.includes(query)) return 40;
  return 0;
}

export function slashCmdMatchScore(query: string, def: SlashCommandDef): number {
  const q = query.toLowerCase();
  return Math.max(
    fuzzyTokenScore(q, def.cmd),
    ...(def.aliases ?? []).map((alias) => fuzzyTokenScore(q, alias)),
    fuzzyTokenScore(q, def.description) * 0.5,
  );
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    cmd: 'permissions',
    aliases: ['permission', 'perms'],
    description: 'Set mode, access, and Approve All for this run',
    icon: Shield,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'agent | plan | ask | read | write | full | approve-all',
    hasOptions: true,
  },
  {
    cmd: 'ask',
    description: 'Switch to Ask Mode (or ask a question)',
    icon: HelpCircle,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<question>',
  },
  {
    cmd: 'plan',
    description: 'Switch to Plan Mode (or plan a goal)',
    icon: ClipboardList,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<goal>',
  },
  {
    cmd: 'agent',
    description: 'Open a live multitask/subagent thread for this chat',
    icon: Bot,
    category: 'chat',
    hasOptions: true,
  },
  {
    cmd: 'multitask',
    description: 'Agent Mode task — launch a chat-native Jarvis agent',
    icon: Bot,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<task>',
  },
  {
    cmd: 'subagents',
    aliases: ['subagent'],
    description: 'Spawn chat-native subagents for the task using this chat model',
    icon: Bot,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<task>',
  },
  {
    cmd: 'terminals',
    aliases: ['terminal'],
    description: 'Reference the terminal surface in chat',
    icon: Terminal,
    category: 'chat',
  },
  {
    cmd: 'context',
    aliases: ['contextmap'],
    description: 'Attach a context map to this chat',
    icon: Network,
    category: 'chat',
    hasOptions: true,
  },
  {
    cmd: 'plug',
    description: 'Attach a connected plugin to this chat',
    icon: Plug,
    category: 'chat',
    hasOptions: true,
  },
  {
    cmd: 'skills',
    description: 'Add a skill to this chat turn',
    icon: Sparkles,
    category: 'chat',
    hasOptions: true,
  },
  {
    cmd: 'allaboutme',
    description: 'Attach, edit, retake, or update AllAboutMe.md',
    icon: Brain,
    category: 'chat',
    hasOptions: true,
  },
  {
    cmd: 'hive',
    description: 'Reference Hive Balanced in chat',
    icon: Sparkles,
    brandIcon: 'hive',
    category: 'chat',
  },
  {
    cmd: 'file',
    description: 'Attach a file from the open project',
    icon: FileText,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<name or path>',
    hasOptions: true,
  },
  {
    cmd: 'md',
    description: 'Create and attach a structured Markdown document',
    icon: FileText,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<type> <brief>',
    hasOptions: true,
  },
  {
    cmd: 'model',
    description: 'Switch AI model',
    icon: Zap,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<provider>',
    hasOptions: true,
  },
  {
    cmd: 'effort',
    description: 'Set reasoning effort for the current model',
    icon: SlidersHorizontal,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'auto | minimal | low | medium | high | ultra | max | status',
    hasOptions: true,
  },
  {
    cmd: 'fast',
    description: 'Use the selected model connection’s real Fast mode',
    icon: Zap,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'on | off | status',
  },
  {
    cmd: 'performance',
    description: 'Set VibeSpace orchestration performance without changing model or effort',
    icon: Gauge,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'responsive | balanced | quality | status',
  },
  {
    cmd: 'rlm',
    description: 'Control adaptive VibeSpace Context/RLM for this chat',
    icon: Brain,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'on | off | status | refresh | trace',
    hasOptions: true,
  },
  {
    cmd: 'access',
    description: 'Set independent tool access ceiling',
    icon: Shield,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'read-only | write | full | status',
  },
  {
    cmd: 'approveall',
    aliases: ['approve-all'],
    description: 'Approve eligible safe actions for the next scoped run only',
    icon: Shield,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'on | off | status',
  },
  {
    cmd: 'mode',
    description: 'Set Token Saver, Normal, or Token Final Boss',
    icon: Gauge,
    category: 'chat',
    takesArg: true,
    argPlaceholder: 'token saver | normal | token final boss',
    hasOptions: true,
  },
  {
    cmd: 'attach',
    description: 'Attach by absolute path',
    icon: FileText,
    category: 'chat',
    takesArg: true,
    argPlaceholder: '<path>',
  },
  {
    cmd: 'clearfiles',
    aliases: ['clearfile', 'clear-files', 'cearfile'],
    description: 'Clear all attached files & images from this message',
    icon: FileText,
    category: 'chat',
  },
  {
    cmd: 'output',
    description: 'Show this chat’s media inputs and outputs',
    icon: ClipboardList,
    category: 'chat',
  },

  { cmd: 'kanban', description: 'Reference Kanban', icon: ListTodo, category: 'navigation' },
  {
    cmd: 'canvas',
    description: 'Reference Canvas',
    icon: Network,
    category: 'navigation',
    hasOptions: true,
  },
  { cmd: 'history', description: 'Reference History', icon: History, category: 'navigation' },
  { cmd: 'tools', description: 'Reference Tools', icon: Wrench, category: 'navigation' },
  {
    cmd: 'agents',
    description: 'Reference Agents page/editor',
    icon: Users,
    category: 'navigation',
  },
  {
    cmd: 'schedule',
    description: 'Reference Schedule',
    icon: CalendarDays,
    category: 'navigation',
  },
  {
    cmd: 'chat',
    description: 'Choose VibeSpace Chat or Browser Chat',
    icon: MessageSquare,
    category: 'chat',
    hasOptions: true,
  },

  {
    cmd: 'usage',
    description: 'Show truthful current-chat usage and quota availability',
    icon: BarChart3,
    category: 'utility',
    argPlaceholder: '[refresh|session|all]',
  },
  {
    cmd: 'theme',
    description: 'Style this agentic chat console',
    icon: Palette,
    category: 'utility',
    takesArg: true,
    argPlaceholder: 'paper white | sakura mist | graphite | oled void',
    hasOptions: true,
  },
  {
    cmd: 'appearance',
    description: 'Switch the global VibeSpace appearance',
    icon: Palette,
    category: 'utility',
    takesArg: true,
    argPlaceholder: 'jarvis one | default | monochrome | warm',
    hasOptions: true,
  },
  {
    cmd: 'undo',
    description: 'Undo the last full chat turn (user + reply)',
    icon: Undo2,
    category: 'utility',
  },
  {
    cmd: 'redo',
    description: 'Redo the last undone chat turn',
    icon: Redo2,
    category: 'utility',
  },
  { cmd: 'commands', description: 'Command catalog', icon: Zap, category: 'utility' },
  { cmd: 'help', description: 'Show help', icon: HelpCircle, category: 'utility' },
];

const CATEGORY_LABELS: Record<string, string> = {
  chat: 'Chat context',
  navigation: 'Navigation',
  utility: 'Utility',
};

const CATEGORY_ORDER = ['chat', 'navigation', 'utility'];

export function orderSlashCommandsForDisplay(commands: SlashCommandDef[]): SlashCommandDef[] {
  const grouped = commands.reduce<Record<string, SlashCommandDef[]>>((acc, cmd) => {
    const cat = cmd.category ?? 'utility';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(cmd);
    return acc;
  }, {});
  return CATEGORY_ORDER.flatMap((category) => grouped[category] ?? []);
}

export interface SlashCommandTypeaheadProps {
  commands: SlashCommandDef[];
  selectedCmd: string;
  query: string;
  onHoverCmd?: (cmd: string) => void;
  onSelect: (cmd: SlashCommandDef) => void;
  /** Dense sizing for pet mini-panel / narrow composer. */
  compact?: boolean;
}

export interface SlashCommandTypeaheadRef {
  moveUp: () => void;
  moveDown: () => void;
  selectCurrent: () => void;
}

export const SlashCommandTypeahead = forwardRef<
  SlashCommandTypeaheadRef,
  SlashCommandTypeaheadProps
>(function SlashCommandTypeahead(
  { commands, selectedCmd, query, onHoverCmd, onSelect, compact = false },
  ref,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const dropdownTransition = useThemeMotionTransition(LEGACY_DROPDOWN_TRANSITION);
  const dropdownMotion = resolveDropdownMotion(reducedMotion, dropdownTransition);
  // Live scale — re-renders when the mini panel is resized while menu is open.
  const panelScale = useLivePanelUiScale(compact);
  const displayCommands = orderSlashCommandsForDisplay(commands);

  useImperativeHandle(ref, () => ({
    moveUp: () => {
      if (displayCommands.length === 0) return;
      const i = displayCommands.findIndex((c) => c.cmd === selectedCmd);
      const next = displayCommands[(i - 1 + displayCommands.length) % displayCommands.length]!;
      onHoverCmd?.(next.cmd);
    },
    moveDown: () => {
      if (displayCommands.length === 0) return;
      const i = displayCommands.findIndex((c) => c.cmd === selectedCmd);
      const next = displayCommands[(i + 1) % displayCommands.length]!;
      onHoverCmd?.(next.cmd);
    },
    selectCurrent: () => {
      const cmd = displayCommands.find((c) => c.cmd === selectedCmd) ?? displayCommands[0];
      if (cmd) onSelect(cmd);
    },
  }));

  useEffect(() => {
    if (!listRef.current || !selectedCmd) return;
    scrollPickerItemIntoView(listRef.current, `[data-value="${selectedCmd}"]`);
  }, [selectedCmd]);

  const groupedCommands = displayCommands.reduce<Record<string, SlashCommandDef[]>>((acc, cmd) => {
    const cat = cmd.category ?? 'utility';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(cmd);
    return acc;
  }, {});

  // Intrinsic compact sizes (not only CSS transform — transform left a huge layout footprint).
  const compactWidth = compact ? Math.round(200 * panelScale + 40 * (1 - panelScale)) : 276;
  const compactFontPx = compact ? Math.max(9, Math.round(11 * panelScale)) : 11;
  const compactMaxH = compact ? Math.round(140 * panelScale + 40) : 200;

  return (
    <motion.div
      {...dropdownMotion}
      data-pet-scaled-picker={compact ? 'true' : undefined}
      data-pet-ui-scale={compact ? String(panelScale) : undefined}
      className={cn(
        'jarvis-slash-dropdown overflow-hidden border border-border-mid/80',
        compact ? 'rounded-[10px] font-mono' : 'w-[276px] rounded-[12px] font-mono text-[11px]',
        'bg-elevated/95 text-foreground backdrop-blur-xl',
        'shadow-[0_18px_48px_rgba(0,0,0,0.48),inset_0_1px_0_hsl(var(--foreground)/0.05)]',
      )}
      style={
        compact
          ? ({
              width: `${compactWidth}px`,
              maxWidth: 'min(86vw, 260px)',
              fontSize: `${compactFontPx}px`,
              ['--pet-ui-scale' as string]: String(panelScale),
            } as CSSProperties)
          : undefined
      }
    >
      <div
        className={cn('border-b border-border bg-panel/90', compact ? 'px-2 py-1' : 'px-3 py-2')}
      >
        <div className="flex items-center gap-1.5">
          <Zap className={cn(compact ? 'h-2.5 w-2.5' : 'h-3 w-3', 'text-accent-copper')} />
          <span className={cn('text-muted-foreground', compact ? 'text-[9px]' : 'text-[10px]')}>
            {query ? `/${query}` : 'commands'}
          </span>
        </div>
      </div>

      <div
        ref={listRef}
        className={cn(
          'overflow-y-auto scrollbar-hidden',
          compact ? 'py-0.5' : 'max-h-[200px] py-0.5',
        )}
        style={compact ? { maxHeight: `${compactMaxH}px` } : undefined}
      >
        {commands.length === 0 ? (
          <div
            className={cn(
              'text-center text-muted-foreground',
              compact ? 'px-1.5 py-2 text-[9px]' : 'px-2 py-3 text-[10px]',
            )}
          >
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
                      {c.brandIcon === 'hive' ? (
                        <HiveModelIcon size={18} className={isSelected ? '' : 'opacity-80'} />
                      ) : (
                        <Icon
                          className={cn(
                            'h-3 w-3 shrink-0',
                            isSelected ? 'text-accent-copper' : 'text-muted-foreground/70',
                          )}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {c.label ?? c.displayCommand ?? `/${c.cmd}`}
                        </span>
                        {c.label ? (
                          <span className="block truncate text-[9px] text-muted-foreground/75">
                            {c.displayCommand} · {c.description}
                          </span>
                        ) : null}
                      </span>
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
