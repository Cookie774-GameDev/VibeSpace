import { useLayoutEffect, useState, type MutableRefObject, type RefObject } from 'react';
import { AnimatedBeam } from './AnimatedBeam';
import { useAgentStore } from '@/stores/agents';
import type { Agent, AgentId, AgentRunState } from '@/types';

/**
 * Run states that should produce an active beam in the council canvas.
 * 'reading' and 'queued' are intentionally excluded - those are quiet states.
 */
const ACTIVE_STATES: ReadonlyArray<AgentRunState> = ['thinking', 'streaming', 'tool_calling'];

const GRADIENT_ID = 'council-beam-gradient';

export interface BeamLayerProps {
  /** Agents currently in the council, in the same order as panels in the grid */
  agents: Agent[];
  /** Ref to the council canvas element (the relative positioning context) */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Mutable ref holding panel DOM nodes keyed by agent id */
  panelRefs: MutableRefObject<Record<string, HTMLDivElement | undefined>>;
}

/**
 * BeamLayer paints animated SVG beams from each active agent panel to a
 * virtual hub at the canvas center. Beams render only when an agent is
 * 'thinking', 'streaming', or 'tool_calling'. The layer recomputes
 * coordinates on container/panel resize via ResizeObserver and on window
 * resize.
 *
 * Coordinates are computed in the container-relative space, which is the
 * same space the absolutely-positioned <svg> covers - so panel-rect minus
 * container-rect gives drawing coordinates directly.
 */
export function BeamLayer({ agents, containerRef, panelRefs }: BeamLayerProps) {
  const runStates = useAgentStore((s) => s.runStates);
  // Tick state forces a re-render when layout shifts (ResizeObserver fires).
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const force = () => setTick((t) => t + 1);

    const observer = new ResizeObserver(force);
    observer.observe(container);

    for (const agent of agents) {
      const el = panelRefs.current[agent.id];
      if (el) observer.observe(el);
    }

    window.addEventListener('resize', force);

    // Initial measurement after observers are attached.
    force();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', force);
    };
  }, [agents, containerRef, panelRefs]);

  // Touch tick so the dependency is recognized; coords are computed each render.
  void tick;

  const container = containerRef.current;
  if (!container) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) {
    return null;
  }

  const hubX = containerRect.width / 2;
  const hubY = containerRect.height / 2;

  type Beam = { id: AgentId; x: number; y: number };

  const beams: Beam[] = [];
  for (const agent of agents) {
    const state = runStates[agent.id];
    if (!state || !ACTIVE_STATES.includes(state)) continue;
    const el = panelRefs.current[agent.id];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    beams.push({
      id: agent.id,
      x: r.left + r.width / 2 - containerRect.left,
      y: r.top + r.height / 2 - containerRect.top,
    });
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={containerRect.width}
      height={containerRect.height}
      style={{ overflow: 'visible' }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={GRADIENT_ID} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="hsl(187 95% 43%)" />
          <stop offset="100%" stopColor="hsl(258 90% 66%)" />
        </linearGradient>
      </defs>

      {beams.length > 0 ? (
        <>
          {/* Subtle hub marker - shown only when at least one beam is active */}
          <circle
            cx={hubX}
            cy={hubY}
            r={6}
            fill={`url(#${GRADIENT_ID})`}
            opacity={0.35}
            className="animate-breathe"
          />
          <circle
            cx={hubX}
            cy={hubY}
            r={2.5}
            fill={`url(#${GRADIENT_ID})`}
            opacity={0.9}
          />
        </>
      ) : null}

      {beams.map((b, i) => (
        <AnimatedBeam
          key={b.id}
          x1={b.x}
          y1={b.y}
          x2={hubX}
          y2={hubY}
          gradientId={GRADIENT_ID}
          delay={i * 0.05}
        />
      ))}
    </svg>
  );
}
