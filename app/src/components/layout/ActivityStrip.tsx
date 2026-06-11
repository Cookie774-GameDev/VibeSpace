import * as React from 'react';
import { Avatar } from '@/components/ui/avatar';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import { formatTokenCount, formatCost } from '@/lib/utils';
import type { AgentRunState } from '@/types';

/**
 * ActivityStrip - 32px bottom row that shows the live state of every
 * agent currently working in council mode. Hidden in any other mode.
 *
 * Each row: avatar + name + verb + token/cost counter.
 */
export function CouncilActivityStrip() {
  const agents = useAgentStore((s) => s.agents);
  const runStates = useAgentStore((s) => s.runStates);
  const verbs = useAgentStore((s) => s.verbs);
  const tokens = useAgentStore((s) => s.tokens);

  const activeAgents = React.useMemo(() => {
    return Object.values(agents).filter((a) => {
      const st = runStates[a.id];
      return st && st !== 'idle' && st !== 'done';
    });
  }, [agents, runStates]);

  return (
    <div
      role="status"
      aria-label="Active agents"
      className="flex h-8 shrink-0 items-center gap-4 border-t border-border bg-elevated px-3 overflow-x-auto scrollbar-hidden"
    >
      {activeAgents.length === 0 ? (
        <span className="text-metadata text-muted-foreground/70">
          {'Waiting for council to start\u2026'}
        </span>
      ) : (
        activeAgents.map((a) => {
          const verb = humanVerb(verbs[a.id], runStates[a.id]);
          const tok = tokens[a.id];
          const tokCount = tok ? tok.input + tok.output : 0;
          return (
            <div key={a.id} className="flex shrink-0 items-center gap-2 text-metadata">
              <Avatar seed={a.slug} initials={a.name.charAt(0)} size={16} />
              <span className="font-medium text-foreground">{a.name}</span>
              <span className="text-muted-foreground">{verb}</span>
              {tok && (tokCount > 0 || tok.cost_usd > 0) && (
                <span className="text-muted-foreground/70 tabular-nums">
                  {formatTokenCount(tokCount)} tok &middot; {formatCost(tok.cost_usd)}
                </span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function humanVerb(custom: string | undefined, state: AgentRunState | undefined): string {
  if (custom) return custom;
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'thinking':
      return 'Thinking\u2026';
    case 'reading':
      return 'Reading\u2026';
    case 'tool_calling':
      return 'Calling tool\u2026';
    case 'streaming':
      return 'Writing\u2026';
    case 'waiting_for_user':
      return 'Awaiting approval';
    case 'error':
      return 'Error';
    default:
      return 'Working\u2026';
  }
}

/** @deprecated Use CouncilActivityStrip — mounted only in council mode. */
export const ActivityStrip = CouncilActivityStrip;
