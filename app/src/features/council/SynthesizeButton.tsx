import { useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentStore } from '@/stores/agents';
import type { AgentId } from '@/types';

export interface SynthesizeButtonProps {
  /** Agent ids participating in this council turn */
  agentIds: AgentId[];
  /** Optional className */
  className?: string;
}

/**
 * The CTA at the top of the council canvas. Disabled until at least 2
 * agents have completed their turn (`runState === 'done'`); enabled, it
 * dispatches a `jarvis:synthesize` CustomEvent on `window` carrying the ids
 * of the agents whose answers should be merged.
 *
 * Listeners (e.g., the Critic agent runtime) subscribe with:
 *   window.addEventListener('jarvis:synthesize', (e) => {
 *     const { agentIds } = (e as CustomEvent<{ agentIds: AgentId[] }>).detail;
 *   });
 */
export function SynthesizeButton({ agentIds, className }: SynthesizeButtonProps) {
  const runStates = useAgentStore((s) => s.runStates);

  const doneAgentIds = useMemo(
    () => agentIds.filter((id) => runStates[id] === 'done'),
    [agentIds, runStates],
  );

  const disabled = doneAgentIds.length < 2;

  const handleClick = () => {
    if (disabled) return;
    window.dispatchEvent(
      new CustomEvent<{ agentIds: AgentId[] }>('jarvis:synthesize', {
        detail: { agentIds: doneAgentIds },
      }),
    );
  };

  return (
    <Button
      variant="accent"
      size="sm"
      onClick={handleClick}
      disabled={disabled}
      className={className}
      aria-label={
        disabled
          ? 'Synthesize: needs at least 2 completed agents'
          : `Synthesize ${doneAgentIds.length} agent answers`
      }
      title={
        disabled
          ? 'Two or more agents must finish before you can synthesize.'
          : `Merge ${doneAgentIds.length} answers via the Critic agent.`
      }
    >
      <Sparkles className="size-3.5" />
      Synthesize
      {doneAgentIds.length > 0 ? (
        <span className="text-metadata opacity-80">({doneAgentIds.length})</span>
      ) : null}
    </Button>
  );
}
