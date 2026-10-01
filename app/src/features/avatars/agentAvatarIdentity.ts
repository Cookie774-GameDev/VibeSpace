import type { Agent, Message } from '@/types';

/** Assistant request IDs can change per turn; the visible assistant remains Jarvis. */
export function agentAvatarIdentityForMessage(
  message: Pick<Message, 'role' | 'agent_id'>,
  agent?: Pick<Agent, 'slug'>,
): string {
  const slug = agent?.slug.trim();
  if (slug) return slug;
  if (message.role === 'assistant') return 'jarvis';
  return String(message.agent_id ?? 'jarvis');
}
