/**
 * AgentRolePicker — compact pane chrome control for terminal agent assignment.
 *
 * One scrollable list: each row sets agent + mode together (no separate mode panel).
 *   - Shell — plain terminal, no agent briefing
 *   - No context — isolated agent (no project context / briefing)
 *   - Named agents — default mode with full context briefing
 */
import * as React from 'react';
import { ChevronDown, Bot, X as XIcon, ShieldOff } from 'lucide-react';
import type { Agent } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { AgentBadge } from '@/features/agents/AgentBadge';
import type { AgentCoordinationMode } from './agentCoordination';

export type AgentRoleSelection = {
  agentSlug: string | null;
  agentMode?: AgentCoordinationMode;
};

export interface AgentRolePickerProps {
  agentSlug?: string | null;
  agentMode?: AgentCoordinationMode;
  /** @deprecated Prefer onSelectionChange — still called for compatibility */
  onChange?: (slug: string | null) => void;
  /** @deprecated Prefer onSelectionChange */
  onModeChange?: (mode: AgentCoordinationMode) => void;
  onSelectionChange?: (selection: AgentRoleSelection) => void;
  className?: string;
}

type PickerOption =
  | { kind: 'shell' }
  | { kind: 'no-context' }
  | { kind: 'agent'; agent: Agent };

function PickerRow({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-metadata',
        'hover:bg-muted transition-colors',
        active && 'bg-muted/70',
        className,
      )}
    >
      {children}
    </button>
  );
}

function isActiveOption(
  option: PickerOption,
  agentSlug: string | null | undefined,
  agentMode: AgentCoordinationMode,
): boolean {
  if (option.kind === 'shell') {
    return !agentSlug && agentMode !== 'no-context' && agentMode !== 'coordinated';
  }
  if (option.kind === 'no-context') {
    return !agentSlug && agentMode === 'no-context';
  }
  if (agentMode === 'coordinated') {
    return option.agent.slug === agentSlug;
  }
  return option.agent.slug === agentSlug && agentMode === 'default';
}

function selectionForOption(option: PickerOption): AgentRoleSelection {
  if (option.kind === 'shell') {
    return { agentSlug: null, agentMode: undefined };
  }
  if (option.kind === 'no-context') {
    return { agentSlug: null, agentMode: 'no-context' };
  }
  return { agentSlug: option.agent.slug, agentMode: 'default' };
}

export function AgentRolePicker({
  agentSlug,
  agentMode = 'default',
  onChange,
  onModeChange,
  onSelectionChange,
  className,
}: AgentRolePickerProps) {
  const [open, setOpen] = React.useState(false);
  const agentsMap = useAgentStore((s) => s.agents);

  const agents = React.useMemo<Agent[]>(() => {
    const all = Object.values(agentsMap);
    const swarmOrder = new Map<string, number>([
      ['scout', 0],
      ['builder', 1],
      ['reviewer', 2],
    ]);
    return all.slice().sort((a, b) => {
      if (swarmOrder.has(a.slug) || swarmOrder.has(b.slug)) {
        const av = swarmOrder.get(a.slug) ?? 99;
        const bv = swarmOrder.get(b.slug) ?? 99;
        if (av !== bv) return av - bv;
      }
      return a.name.localeCompare(b.name);
    });
  }, [agentsMap]);

  const selected = agentSlug ? agents.find((a) => a.slug === agentSlug) ?? null : null;

  const applySelection = (selection: AgentRoleSelection) => {
    onSelectionChange?.(selection);
    onChange?.(selection.agentSlug);
    if (selection.agentMode) {
      onModeChange?.(selection.agentMode);
    }
    setOpen(false);
  };

  const options = React.useMemo<PickerOption[]>(() => {
    const out: PickerOption[] = [{ kind: 'shell' }, { kind: 'no-context' }];
    for (const agent of agents) {
      out.push({ kind: 'agent', agent });
    }
    return out;
  }, [agents]);

  const triggerLabel = React.useMemo(() => {
    if (agentMode === 'no-context' && !selected) return 'No context';
    if (selected) {
      return agentMode === 'coordinated' ? `${selected.name} · swarm` : selected.name;
    }
    return 'Agent';
  }, [agentMode, selected]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Assign agent: ${triggerLabel}`}
          title={triggerLabel}
          className={cn(
            'inline-flex h-5 max-w-[7.5rem] items-center gap-0.5 rounded px-1 transition-colors',
            'text-metadata text-muted-foreground hover:bg-muted hover:text-foreground',
            selected && 'text-foreground',
            agentMode === 'no-context' && !selected && 'text-foreground',
            className,
          )}
        >
          {selected ? (
            <AgentBadge agent={selected} size="sm" showName className="min-w-0 truncate" />
          ) : agentMode === 'no-context' ? (
            <ShieldOff className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <Bot className="h-3 w-3 shrink-0" aria-hidden />
          )}
          {!selected && (
            <span className="truncate">{agentMode === 'no-context' ? 'No ctx' : 'Agent'}</span>
          )}
          <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[188px] p-0.5">
        <div
          className="max-h-[min(11rem,38vh)] overflow-y-auto overflow-x-hidden scrollbar-hidden"
          role="listbox"
          aria-label="Terminal agent options"
        >
          {options.map((option) => {
            const active = isActiveOption(option, agentSlug, agentMode);
            if (option.kind === 'shell') {
              return (
                <PickerRow
                  key="shell"
                  active={active}
                  onClick={() => applySelection(selectionForOption(option))}
                >
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
                    <XIcon className="h-2.5 w-2.5" aria-hidden />
                  </span>
                  <span className="truncate text-foreground">Shell</span>
                </PickerRow>
              );
            }
            if (option.kind === 'no-context') {
              return (
                <PickerRow
                  key="no-context"
                  active={active}
                  onClick={() => applySelection(selectionForOption(option))}
                >
                  <ShieldOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate text-foreground">No context</span>
                </PickerRow>
              );
            }
            return (
              <PickerRow
                key={option.agent.id}
                active={active}
                onClick={() => applySelection(selectionForOption(option))}
              >
                <AgentBadge agent={option.agent} showName={false} size="sm" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {option.agent.name}
                </span>
              </PickerRow>
            );
          })}
          {agents.length === 0 && (
            <div className="px-2 py-2 text-metadata text-muted-foreground">No agents loaded.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
