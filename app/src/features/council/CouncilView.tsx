import { useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { CouncilGrid } from './CouncilGrid';
import { BeamLayer } from './BeamLayer';
import { SynthesizeButton } from './SynthesizeButton';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agents';
import type { Agent, AgentId, Message } from '@/types';

export interface CouncilViewProps {
  /**
   * Agent ids participating in this council turn. Typically derived from the
   * active chat's `active_agent_ids`. If omitted, falls back to every agent
   * registered in the agent store - useful for visual development.
   */
  agentIds?: AgentId[];
  /**
   * Messages for the active chat. Each AgentPanel filters this list to its
   * own agent id, plus role==='user' so the originating prompt appears in
   * every panel.
   */
  messages?: Message[];
  /** Optional className for the root container */
  className?: string;
}

/**
 * The council main canvas.
 *
 * Renders a top header bar with a Synthesize CTA, then a relative-positioned
 * canvas containing the CouncilGrid and an absolutely-positioned BeamLayer
 * overlay drawing animated beams from active panels to a central hub.
 *
 * Layout is fluid - the grid fills available height, and panels reflow when
 * agents enter or leave. Layout animations use Motion springs.
 */
export function CouncilView({ agentIds, messages, className }: CouncilViewProps) {
  const agentsMap = useAgentStore((s) => s.agents);

  // Resolve which agents to display. Explicit prop wins; otherwise show
  // everything in the registry. Order: prop order, then registry order.
  const agents = useMemo<Agent[]>(() => {
    if (agentIds && agentIds.length > 0) {
      const out: Agent[] = [];
      for (const id of agentIds) {
        const a = agentsMap[id];
        if (a) out.push(a);
      }
      return out;
    }
    return Object.values(agentsMap);
  }, [agentIds, agentsMap]);

  const resolvedMessages = messages ?? [];
  const participantIds = useMemo(() => agents.map((a) => a.id), [agents]);

  // Container ref bounds the BeamLayer's coordinate space.
  const containerRef = useRef<HTMLDivElement>(null);
  // Panel refs are keyed by agent id; CouncilGrid populates, BeamLayer reads.
  const panelRefs = useRef<Record<string, HTMLDivElement | undefined>>({});

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 px-4 h-11 border-b border-border bg-background shrink-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-ui-strong">Council</span>
          <span className="text-secondary text-muted-foreground truncate">
            {agents.length === 0
              ? 'no agents'
              : `${agents.length} agent${agents.length === 1 ? '' : 's'} in parallel`}
          </span>
        </div>
        <SynthesizeButton agentIds={participantIds} />
      </div>

      {/* Canvas */}
      <motion.div
        ref={containerRef}
        layout
        className="relative flex-1 min-h-0 p-3 bg-background"
      >
        {agents.length === 0 ? (
          <div className="flex h-full items-center justify-center text-secondary text-muted-foreground">
            No active agents in this council. Add one to begin.
          </div>
        ) : (
          <>
            <CouncilGrid agents={agents} messages={resolvedMessages} panelRefs={panelRefs} />
            <BeamLayer agents={agents} containerRef={containerRef} panelRefs={panelRefs} />
          </>
        )}
      </motion.div>
    </div>
  );
}
