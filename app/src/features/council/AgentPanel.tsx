import { forwardRef, useMemo, type ReactElement } from 'react';
import { motion } from 'motion/react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn, formatCost, formatTokenCount, hueFromString } from '@/lib/utils';
import { useAgentStore } from '@/stores/agents';
import type { Agent, AgentRunState, Message, Part } from '@/types';

export interface AgentPanelProps {
  /** The agent this panel represents */
  agent: Agent;
  /** Messages from the active chat. The panel filters to its own agent + user prompts. */
  messages: Message[];
  /** Optional className for the outermost element */
  className?: string;
}

const ACTIVE_RUN_STATES: ReadonlyArray<AgentRunState> = ['thinking', 'streaming', 'tool_calling'];

/**
 * AgentPanel renders one agent's view inside the council grid.
 *
 * Layout: 36px header (avatar + name + run-state pill + token counter) on top
 * of a flex-1 scrollable message list. The left edge is colored with the
 * agent's hue; when the agent is actively producing output, the panel border
 * switches to the cyan-violet accent gradient and a soft glow appears.
 *
 * The panel filters messages to those whose `agent_id` matches this agent
 * AND every user prompt (so each panel sees the same prompt that started
 * the turn).
 */
export const AgentPanel = forwardRef<HTMLDivElement, AgentPanelProps>(
  ({ agent, messages, className }, ref) => {
    const runState = useAgentStore((s) => s.runStates[agent.id]);
    const verb = useAgentStore((s) => s.verbs[agent.id]);
    const tokens = useAgentStore((s) => s.tokens[agent.id]);

    const isActive = runState !== undefined && ACTIVE_RUN_STATES.includes(runState);

    const hue = agent.color_hue ?? hueFromString(agent.slug);
    const agentColor = `hsl(${hue}, 70%, 60%)`;
    const agentGlow = `hsla(${hue}, 70%, 60%, 0.45)`;

    const filteredMessages = useMemo(
      () => messages.filter((m) => m.role === 'user' || m.agent_id === agent.id),
      [messages, agent.id],
    );

    const totalTokens = (tokens?.input ?? 0) + (tokens?.output ?? 0);
    const totalCost = tokens?.cost_usd ?? 0;

    return (
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30, mass: 0.8 }}
        className={cn(
          'relative flex flex-col bg-panel rounded-md overflow-hidden min-h-0',
          isActive ? 'border-accent-gradient' : 'border border-border',
          className,
        )}
        style={{
          borderLeftColor: !isActive ? agentColor : undefined,
          boxShadow: isActive ? `0 0 28px -8px ${agentGlow}` : undefined,
        }}
        data-agent-id={agent.id}
        data-active={isActive ? 'true' : 'false'}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-2 px-3 border-b border-border bg-panel shrink-0"
          style={{ height: 36 }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Avatar seed={agent.slug} initials={agent.name.charAt(0)} size={20} />
            <span className="text-ui-strong truncate" title={agent.name}>
              {agent.name}
            </span>
            <RunStatePill state={runState} verb={verb} />
          </div>
          <TokenCounter tokens={totalTokens} cost={totalCost} />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {filteredMessages.length === 0 ? (
            <EmptyState agentName={agent.name} runState={runState} />
          ) : (
            <div className="space-y-2">
              {filteredMessages.map((m) => (
                <MessageItem key={m.id} message={m} agentColor={agentColor} />
              ))}
            </div>
          )}
        </div>
      </motion.div>
    );
  },
);
AgentPanel.displayName = 'AgentPanel';

/* ------------------------------- helpers ------------------------------- */

type PillVariant = 'default' | 'secondary' | 'accent' | 'outline' | 'success' | 'warning' | 'destructive';

function variantForState(state: AgentRunState): PillVariant {
  if (state === 'error') return 'destructive';
  if (state === 'done') return 'success';
  if (state === 'waiting_for_user') return 'warning';
  if (state === 'thinking' || state === 'streaming' || state === 'tool_calling') return 'accent';
  return 'secondary';
}

function RunStatePill({ state, verb }: { state?: AgentRunState; verb?: string }): ReactElement | null {
  if (!state || state === 'idle') return null;
  const label = verb ?? state.replace(/_/g, ' ');
  return (
    <Badge variant={variantForState(state)} className="lowercase">
      {label}
    </Badge>
  );
}

function TokenCounter({ tokens, cost }: { tokens: number; cost: number }): ReactElement {
  return (
    <div className="flex items-baseline gap-1.5 shrink-0 font-mono text-metadata text-muted-foreground">
      <span>{formatTokenCount(tokens)}</span>
      {cost > 0 ? <span className="opacity-70">{formatCost(cost)}</span> : null}
    </div>
  );
}

function EmptyState({
  agentName,
  runState,
}: {
  agentName: string;
  runState?: AgentRunState;
}): ReactElement {
  let label: string;
  if (runState === 'error') label = `${agentName} hit an error.`;
  else if (runState === 'queued') label = `${agentName} is queued...`;
  else if (runState === 'thinking') label = `${agentName} is thinking...`;
  else label = `Waiting for ${agentName}.`;
  return (
    <div className="flex h-full items-center justify-center text-secondary text-muted-foreground">
      {label}
    </div>
  );
}

function MessageItem({
  message,
  agentColor,
}: {
  message: Message;
  agentColor: string;
}): ReactElement {
  const isUser = message.role === 'user';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 32, mass: 0.6 }}
      className={cn(
        'rounded-md px-2.5 py-1.5',
        isUser ? 'bg-elevated/60 border border-border/60' : 'bg-transparent',
      )}
      style={
        !isUser
          ? { borderLeft: `2px solid ${agentColor}`, paddingLeft: 10 }
          : undefined
      }
    >
      <div className="text-metadata text-muted-foreground mb-0.5 uppercase tracking-wider">
        {isUser ? 'You' : message.role}
      </div>
      <div className="space-y-1">
        {message.parts.map((part, i) => (
          <MessagePart key={i} part={part} />
        ))}
      </div>
    </motion.div>
  );
}

function MessagePart({ part }: { part: Part }): ReactElement {
  switch (part.kind) {
    case 'text':
      return <p className="text-body whitespace-pre-wrap break-words">{part.text}</p>;
    case 'reasoning':
      return (
        <p className="text-secondary text-muted-foreground italic whitespace-pre-wrap break-words">
          {part.text}
        </p>
      );
    case 'tool_call':
      return (
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="font-mono">
            -&gt; {part.tool}
          </Badge>
        </div>
      );
    case 'tool_result':
      return (
        <Badge variant={part.error ? 'destructive' : 'success'} className="font-mono">
          {part.error ? 'tool error' : 'tool ok'}
        </Badge>
      );
    case 'image':
      return (
        <div className="text-secondary text-muted-foreground">
          [image{part.alt ? `: ${part.alt}` : ''}]
        </div>
      );
    case 'file_ref':
      return (
        <div className="text-secondary text-muted-foreground font-mono">
          [{part.ref.kind}:{part.ref.id}]
        </div>
      );
    case 'action_proposal':
      // Council agents shouldn't be proposing actions, but if any
      // part type lands here we render a compact, read-only line so
      // the panel never shows a blank cell.
      return (
        <Badge variant="outline" className="font-mono">
          action: {part.action_id} ({part.status})
        </Badge>
      );
  }
}
