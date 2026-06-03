/**
 * AgentRolePicker — small chrome-strip control that tags a terminal pane
 * with an agent slug ("Builder", "Scout", "Reviewer", etc.).
 *
 * Visually it's a tiny pill-button that opens a popover. The popover
 * shows every registered agent (defaults: Jarvis, Researcher, Coder,
 * Writer, Critic, Memory Keeper, Action Extractor, Scout, Builder,
 * Reviewer) plus a "None" option to clear the tag.
 *
 * Behaviour today:
 *   - The picker writes `agentSlug` onto the leaf and surfaces the
 *     selection visually.
 *   - When the user selects a role and the pane has no command yet,
 *     the parent pre-fills a sensible default ("claude" for Builder,
 *     etc. — see TerminalsPage.commandForAgent).
 *
 * Behaviour deliberately *not* in this turn:
 *   - We do NOT pipe `terminal://output` to that agent's chat.
 *   - We do NOT route LLM calls based on the tag.
 *   The slot is here so the orchestration layer can land later
 *   without rewriting the layout.
 */
import * as React from 'react';
import { ChevronDown, Bot, X as XIcon } from 'lucide-react';
import type { Agent } from '@/types';
import { useAgentStore } from '@/stores/agents';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { AgentBadge } from '@/features/agents/AgentBadge';

export interface AgentRolePickerProps {
  /** Currently-tagged agent slug (e.g. 'builder'). null/undefined = no tag. */
  agentSlug?: string | null;
  /** Called with the new slug, or `null` to clear. */
  onChange: (slug: string | null) => void;
  /** Compact rendering for the pane chrome strip. */
  className?: string;
}

/**
 * Render one popover row. Pulled out so the empty-state and the agent
 * rows can share visual structure.
 */
function PickerRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-secondary',
        'hover:bg-muted transition-colors',
        active && 'bg-muted/60',
      )}
    >
      {children}
    </button>
  );
}

export function AgentRolePicker({ agentSlug, onChange, className }: AgentRolePickerProps) {
  const [open, setOpen] = React.useState(false);
  const agentsMap = useAgentStore((s) => s.agents);

  // Stable, sorted list. We surface the swarm trio (scout/builder/reviewer)
  // first because that's the headline use case for this picker, then the
  // rest of the roster alphabetically.
  const agents = React.useMemo<Agent[]>(() => {
    const all = Object.values(agentsMap);
    const swarmOrder = new Map<string, number>([
      ['scout', 0],
      ['builder', 1],
      ['reviewer', 2],
    ]);
    return all.slice().sort((a, b) => {
      const ai = swarmOrder.get(a.slug) ?? 100 + a.name.localeCompare(b.name);
      const bi = swarmOrder.get(b.slug) ?? 100 + b.name.localeCompare(b.name);
      // First sort by swarm priority, fall back to alphabetical name.
      if (swarmOrder.has(a.slug) || swarmOrder.has(b.slug)) {
        const av = swarmOrder.get(a.slug) ?? 99;
        const bv = swarmOrder.get(b.slug) ?? 99;
        if (av !== bv) return av - bv;
      }
      return a.name.localeCompare(b.name);
    });
  }, [agentsMap]);

  const selected = agentSlug ? agents.find((a) => a.slug === agentSlug) ?? null : null;

  const choose = (slug: string | null) => {
    onChange(slug);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={selected ? `Agent: ${selected.name}` : 'Assign agent'}
          title={selected ? `Agent: ${selected.name}` : 'Assign an agent role'}
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded px-1.5 transition-colors',
            'text-metadata text-muted-foreground hover:bg-muted hover:text-foreground',
            selected && 'text-foreground',
            className,
          )}
        >
          {selected ? (
            <AgentBadge agent={selected} size="sm" showName />
          ) : (
            <>
              <Bot className="h-3 w-3" />
              <span>Agent</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[260px] p-1"
      >
        <div className="px-2 py-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
          Pane role
        </div>
        <Separator className="mb-1" />
        <div className="max-h-[280px] overflow-y-auto">
          <PickerRow active={!agentSlug} onClick={() => choose(null)}>
            <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border text-muted-foreground">
              <XIcon className="h-3 w-3" />
            </span>
            <span className="text-foreground">No role (plain shell)</span>
          </PickerRow>
          {agents.length === 0 ? (
            <div className="px-3 py-3 text-metadata text-muted-foreground">
              No agents loaded yet.
            </div>
          ) : (
            agents.map((agent) => (
              <PickerRow
                key={agent.id}
                active={agent.slug === agentSlug}
                onClick={() => choose(agent.slug)}
              >
                <AgentBadge agent={agent} showName={false} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{agent.name}</div>
                  <div className="truncate text-metadata text-muted-foreground">
                    {agent.description}
                  </div>
                </div>
              </PickerRow>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
