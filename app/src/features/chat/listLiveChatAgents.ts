/**
 * Live multitask/subagent listing for the /agent slash selector.
 */
import type { JarvisChatAgent, JarvisAgentStatus } from '@/features/jarvis-interaction/types';

const TERMINAL: ReadonlySet<JarvisAgentStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'blocked',
]);

export function isLiveChatAgent(
  agent: JarvisChatAgent,
  now = Date.now(),
  recentDoneMs = 30 * 60_000,
): boolean {
  if (!TERMINAL.has(agent.status)) return true;
  const updated = Date.parse(agent.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now - updated <= recentDoneMs;
}

export function listLiveChatAgents(
  agents: readonly JarvisChatAgent[],
  now = Date.now(),
): JarvisChatAgent[] {
  const live = agents.filter((agent) => isLiveChatAgent(agent, now));
  return live.slice().sort((a, b) => {
    const aLive = !TERMINAL.has(a.status) ? 0 : 1;
    const bLive = !TERMINAL.has(b.status) ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function agentSelectorOptions(
  agents: readonly JarvisChatAgent[],
  now = Date.now(),
): Array<{
  id: string;
  label: string;
  description: string;
  childChatId: string;
}> {
  return listLiveChatAgents(agents, now).map((agent) => ({
    id: String(agent.agentId),
    label: agent.name,
    description: `${agent.status} · ${agent.task} · ${agent.modelLabel}`,
    childChatId: String(agent.childChatId),
  }));
}
