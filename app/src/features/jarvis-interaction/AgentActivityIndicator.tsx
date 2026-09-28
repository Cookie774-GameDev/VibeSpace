import { Bot } from 'lucide-react';
import { useUnifiedChatActivity } from '@/features/chat/activity/unifiedActivity';
import {
  AgentMotionIndicator,
  resolveAgentMotion,
} from '@/features/chat/agentic-console/AgentMotionIndicator';
import type { JarvisChatAgent } from './types';

const MOVING_STATUSES = new Set([
  'queued',
  'resuming',
  'working',
  'thinking',
  'planning',
  'editing',
  'testing',
]);

/** Reuse live runtime evidence; never infer communication from task prose. */
export function AgentActivityIndicator({ agent }: { agent: JarvisChatAgent }) {
  const child = useUnifiedChatActivity(String(agent.childChatId));
  const parent = useUnifiedChatActivity(String(agent.parentChatId));
  const event = [
    ...child,
    ...parent.filter(
      (item) =>
        String(item.agentId) === String(agent.agentId) ||
        (agent.harnessSessionId && item.nativeTask?.sessionId === agent.harnessSessionId),
    ),
  ]
    .filter((item) => item.status === 'running' || item.status === 'pending')
    .sort((a, b) => b.ts - a.ts)[0];
  const motion = MOVING_STATUSES.has(agent.status)
    ? resolveAgentMotion(
        event
          ? {
              status: event.status,
              activityCategory: event.category,
              activityKind: event.kind,
              semanticIntent: event.semanticIntent,
            }
          : { status: 'running', activityKind: 'subagent' },
      )
    : null;
  return (
    <span className="agent-task-icon" aria-hidden="true">
      {motion ? <AgentMotionIndicator motion={motion} compact /> : <Bot className="h-4 w-4" />}
    </span>
  );
}
