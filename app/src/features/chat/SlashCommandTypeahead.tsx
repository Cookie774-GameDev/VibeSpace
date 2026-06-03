import { Command } from 'cmdk';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  CalendarDays,
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
} from 'lucide-react';

export interface SlashCommandDef {
  cmd: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  takesArg?: boolean;
  argPlaceholder?: string;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { cmd: 'contextmap', description: 'Attach a context map to this chat', icon: Network },
  { cmd: 'file', description: 'Attach a project file to this chat', icon: FileText, takesArg: true, argPlaceholder: '<filename>' },
  { cmd: 'model', description: 'Switch AI model provider', icon: Zap, takesArg: true, argPlaceholder: '<provider>' },
  { cmd: 'attach', description: 'Attach a file by absolute path', icon: FileText, takesArg: true, argPlaceholder: '<path>' },
  { cmd: 'usage', description: 'Show current provider usage info', icon: BarChart3 },
  { cmd: 'terminals', description: 'Open the Terminals page', icon: Terminal },
  { cmd: 'files', description: 'Open the Files page', icon: FileText },
  { cmd: 'kanban', description: 'Open the Kanban board', icon: ListTodo },
  { cmd: 'context', description: 'Open the Context page', icon: Network },
  { cmd: 'history', description: 'Open chat history', icon: History },
  { cmd: 'tools', description: 'Open the Tools page', icon: Wrench },
  { cmd: 'agents', description: 'Open the Agents page', icon: Users },
  { cmd: 'schedule', description: 'Open the Schedule page', icon: CalendarDays },
  { cmd: 'chat', description: 'Return to the Chat canvas', icon: MessageSquare },
  { cmd: 'clearfiles', description: 'Clear all attached files', icon: FileText },
  { cmd: 'commands', description: 'Show the full Jarvis command catalog', icon: Zap },
  { cmd: 'help', description: 'Show slash command help', icon: HelpCircle },
];

export interface SlashCommandTypeaheadProps {
  /** Commands matching the typeahead query, already filtered + sorted. */
  commands: SlashCommandDef[];
  /** Currently highlighted command (controlled). */
  selectedCmd: string;
  /** What the user typed after the '/' (used for the empty-state copy). */
  query: string;
  /** Called when user hovers an item. */
  onHoverCmd?: (cmd: string) => void;
  /** Called when user activates an item. */
  onSelect: (cmd: SlashCommandDef) => void;
}

/**
 * Slash command typeahead list. Mirrors the MentionTypeahead pattern
 * but shows available /commands with icons and descriptions.
 * Keyboard handling lives in Composer; this component is presentational.
 */
export function SlashCommandTypeahead({
  commands,
  selectedCmd,
  query,
  onHoverCmd,
  onSelect,
}: SlashCommandTypeaheadProps) {
  return (
    <Command
      shouldFilter={false}
      value={selectedCmd}
      onValueChange={() => {}}
      className="outline-none"
      loop
    >
      <Command.List className="max-h-[260px] overflow-y-auto py-1">
        {commands.length === 0 ? (
          <Command.Empty className="px-3 py-3 text-secondary text-muted-foreground">
            No commands match <span className="font-mono text-foreground">/{query}</span>
          </Command.Empty>
        ) : (
          commands.map((c) => {
            const Icon = c.icon;
            const label = c.takesArg && c.argPlaceholder
              ? `/${c.cmd} ${c.argPlaceholder}`
              : `/${c.cmd}`;
            return (
              <Command.Item
                key={c.cmd}
                value={c.cmd}
                onSelect={() => onSelect(c)}
                onMouseEnter={() => onHoverCmd?.(c.cmd)}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 mx-1 rounded cursor-pointer',
                  'text-secondary text-foreground',
                  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
                <span className="font-mono text-secondary text-accent-copper">{label}</span>
                <span className="text-secondary text-muted-foreground truncate">{c.description}</span>
              </Command.Item>
            );
          })
        )}
      </Command.List>
    </Command>
  );
}
