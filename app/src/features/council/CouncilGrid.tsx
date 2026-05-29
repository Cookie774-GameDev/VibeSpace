import { type MutableRefObject } from 'react';
import { AnimatePresence } from 'motion/react';
import { AgentPanel } from './AgentPanel';
import type { Agent, Message } from '@/types';

export interface CouncilGridProps {
  /** Agents to render (one panel each) */
  agents: Agent[];
  /** Messages to feed into every panel; each panel filters to its own agent */
  messages: Message[];
  /**
   * Mutable ref bag where we register each panel's DOM node by agent id.
   * BeamLayer reads this to compute beam endpoints.
   */
  panelRefs: MutableRefObject<Record<string, HTMLDivElement | undefined>>;
  /** Optional className for the grid wrapper */
  className?: string;
}

/**
 * Choose the column count for N panels.
 * - N <= 1 -> 1 col
 * - N == 2 -> 2 cols (side by side)
 * - N == 3 or 4 -> 2 cols (2x2)
 * - N == 5..9 -> 3 cols
 * - N >= 10 -> capped at 4 cols
 *
 * Uses ceil(sqrt(N)) capped at 4.
 */
function colsFor(count: number): number {
  if (count <= 1) return 1;
  return Math.min(4, Math.ceil(Math.sqrt(count)));
}

/**
 * CouncilGrid is a responsive grid where each cell wraps an AgentPanel.
 * Rows are fr-distributed so each panel gets equal vertical space within the
 * canvas. Panel DOM nodes are exposed through panelRefs for the BeamLayer.
 */
export function CouncilGrid({ agents, messages, panelRefs, className }: CouncilGridProps) {
  const cols = colsFor(agents.length);
  const rows = Math.max(1, Math.ceil(agents.length / cols));

  return (
    <div
      className={'grid gap-3 h-full min-h-0 ' + (className ?? '')}
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
      data-cols={cols}
      data-count={agents.length}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {agents.map((agent) => (
          <AgentPanel
            key={agent.id}
            agent={agent}
            messages={messages}
            ref={(node) => {
              if (node) panelRefs.current[agent.id] = node;
              else delete panelRefs.current[agent.id];
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
