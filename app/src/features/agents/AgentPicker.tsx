/**
 * AgentPicker - dropdown for selecting which agent(s) drive a chat.
 *
 * Two modes:
 *   - single (default): radio-style, picking one replaces the current selection.
 *   - multi: checkbox-style, used in council mode to assemble the panel.
 *
 * Visuals: a button showing the current selection (AgentBadge or count) opens
 * a Popover with a list. Each row is an agent name + description, with a check
 * (single) or checkbox (multi) on the trailing edge.
 */
import * as React from 'react';
import { Check, Users, ChevronDown, Plus } from 'lucide-react';
import type { Agent, AgentId } from '@/types';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { AgentBadge } from './AgentBadge';

export interface AgentPickerProps {
  /** All selectable agents. */
  agents: Agent[];
  /** Currently selected agent id(s). Single mode reads only the first entry. */
  selected: AgentId[];
  /** Called with the new selection. */
  onChange: (selected: AgentId[]) => void;
  /** 'single' (default) or 'multi'. */
  mode?: 'single' | 'multi';
  /** Override the trigger text when no agent is selected. */
  placeholder?: string;
  /** Disable the trigger entirely. */
  disabled?: boolean;
  /** Compact size variant for inline composer use. */
  size?: 'sm' | 'md';
  /** Optional className for the trigger button. */
  className?: string;
}

/**
 * Render the right-edge indicator on each row depending on selection state.
 */
function RowIndicator({ checked, mode }: { checked: boolean; mode: 'single' | 'multi' }) {
  if (mode === 'single') {
    return checked ? <Check className="h-3.5 w-3.5 text-accent-cyan" /> : null;
  }
  return (
    <span
      aria-hidden
      className={cn(
        'h-3.5 w-3.5 rounded border flex items-center justify-center transition-colors',
        checked ? 'border-accent-cyan bg-accent-cyan/20' : 'border-border',
      )}
    >
      {checked && <Check className="h-2.5 w-2.5 text-accent-cyan" strokeWidth={3} />}
    </span>
  );
}

export function AgentPicker({
  agents,
  selected,
  onChange,
  mode = 'single',
  placeholder = 'Select agent',
  disabled,
  size = 'md',
  className,
}: AgentPickerProps) {
  const [open, setOpen] = React.useState(false);

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const selectedAgents = React.useMemo(
    () => agents.filter((a) => selectedSet.has(a.id)),
    [agents, selectedSet],
  );

  const toggle = (id: AgentId) => {
    if (mode === 'single') {
      onChange([id]);
      setOpen(false);
      return;
    }
    if (selectedSet.has(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  // What goes inside the trigger button.
  let triggerContent: React.ReactNode;
  if (mode === 'multi' && selectedAgents.length > 1) {
    triggerContent = (
      <span className="inline-flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5" />
        <span className="font-medium">{selectedAgents.length} agents</span>
      </span>
    );
  } else if (selectedAgents[0]) {
    triggerContent = <AgentBadge agent={selectedAgents[0]} size={size} />;
  } else {
    triggerContent = (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Plus className="h-3.5 w-3.5" />
        {placeholder}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === 'sm' ? 'sm' : 'default'}
          disabled={disabled}
          className={cn('justify-between gap-2 min-w-[140px]', className)}
        >
          {triggerContent}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[300px] p-1">
        <div className="px-2 py-1.5 text-metadata text-muted-foreground uppercase tracking-wide">
          {mode === 'multi' ? 'Active agents' : 'Choose agent'}
        </div>
        <Separator className="mb-1" />
        <div className="max-h-[320px] overflow-y-auto">
          {agents.length === 0 ? (
            <div className="px-3 py-4 text-secondary text-muted-foreground">
              No agents available.
            </div>
          ) : (
            agents.map((agent) => {
              const checked = selectedSet.has(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggle(agent.id)}
                  className={cn(
                    'flex items-start gap-2 w-full text-left rounded px-2 py-2',
                    'hover:bg-muted transition-colors',
                    checked && 'bg-muted/60',
                  )}
                >
                  <div className="flex-1 min-w-0 flex items-start gap-2">
                    <AgentBadge agent={agent} showName={false} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="text-secondary font-medium text-foreground truncate">
                        {agent.name}
                      </div>
                      <div className="text-metadata text-muted-foreground line-clamp-2">
                        {agent.description}
                      </div>
                    </div>
                  </div>
                  <div className="pt-0.5">
                    <RowIndicator checked={checked} mode={mode} />
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
