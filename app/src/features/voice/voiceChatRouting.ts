/**
 * Route voice utterances to Jarvis's chat by default, or to a specialist
 * agent chat only when the user explicitly names one.
 */
import { db, chatRepo } from '@/lib/db';
import { IntentClassifier } from './IntentClassifier';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Agent, AgentId, Chat, ChatId, ProjectId, WorkspaceId } from '@/types';

export interface VoiceChatTarget {
  chatId: ChatId;
  /** Text to persist and send to the runtime (routing prefixes stripped). */
  messageText: string;
  /** Force a specific agent for this turn. */
  agentId?: AgentId;
  mentionedAgentIds?: AgentId[];
}

const JARVIS_SLUG = 'jarvis';

const DICTATION_AGENT_RX =
  /^(?:type|dictate|write)\s+(?:this\s+)?(?:into|in|to)\s+(?:the\s+)?([a-z][a-z0-9_-]*)\b/i;

/** Leading `@slug` mention (same shape as runtime `detectMention`). */
export function detectVoiceMention(text: string): string | null {
  const match = /(?:^|\s)@([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/.exec(text.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** True when the chat's bound agent is Jarvis (or unset → Jarvis default). */
export function isJarvisChat(chat: Chat, agents: Record<string, Agent>): boolean {
  const boundId = chat.active_agent_ids?.[0];
  if (!boundId) return true;
  const bound = agents[boundId];
  return !bound || bound.slug === JARVIS_SLUG;
}

/** Detect an explicitly named non-Jarvis agent in a voice utterance. */
export function detectExplicitVoiceAgentSlug(utterance: string): string | null {
  const text = utterance.trim();
  if (!text) return null;

  const intent = IntentClassifier.classify(text);
  if (intent.intent === 'agent_route' && intent.slots.target_agent) {
    const slug = intent.slots.target_agent.toLowerCase();
    return slug === JARVIS_SLUG ? null : slug;
  }

  const atSlug = detectVoiceMention(text);
  if (atSlug && atSlug !== JARVIS_SLUG) return atSlug;

  const dictation = DICTATION_AGENT_RX.exec(text);
  if (dictation?.[1]) {
    const slug = dictation[1].toLowerCase();
    return slug === JARVIS_SLUG ? null : slug;
  }

  return null;
}

export function voiceMessageTextForAgentRoute(
  utterance: string,
  slug: string,
): string {
  const text = utterance.trim();
  const intent = IntentClassifier.classify(text);
  if (intent.intent === 'agent_route' && intent.slots.query?.trim()) {
    return intent.slots.query.trim();
  }

  const atMatch = new RegExp(`^@${slug}\\s+`, 'i').exec(text);
  if (atMatch) return text.slice(atMatch[0].length).trim() || text;

  const dictMatch = DICTATION_AGENT_RX.exec(text);
  if (dictMatch) {
    return text.slice(dictMatch[0].length).replace(/^[\s,:.-]+/, '').trim() || text;
  }

  return text;
}

function scopedChats(chats: Chat[], projectId: ProjectId | null): Chat[] {
  return projectId
    ? chats.filter((c) => c.project_id === projectId)
    : chats.filter((c) => !c.project_id);
}

function findAgentBySlug(slug: string): Agent | null {
  const wanted = slug.trim().toLowerCase();
  const agents = useAgentStore.getState().agents;
  return Object.values(agents).find((a) => a.slug.toLowerCase() === wanted) ?? null;
}

async function listScopedChats(): Promise<Chat[]> {
  const auth = useAuthStore.getState();
  if (!auth.workspaceId) return [];
  const rows = await db.chats.where('workspace_id').equals(auth.workspaceId).toArray();
  return scopedChats(rows, auth.projectId as ProjectId | null);
}

/** Most recent Jarvis chat in the active project, or create one. */
export async function ensureJarvisChatForVoice(
  titleHint?: string,
): Promise<ChatId | null> {
  const auth = useAuthStore.getState();
  if (!auth.workspaceId) return null;

  const agents = useAgentStore.getState().agents;
  const scoped = await listScopedChats();
  const jarvisChats = scoped
    .filter((chat) => isJarvisChat(chat, agents))
    .sort((a, b) => b.updated_at - a.updated_at);

  if (jarvisChats.length > 0) {
    return jarvisChats[0]!.id;
  }

  const chat = await chatRepo.create({
    workspace_id: auth.workspaceId as WorkspaceId,
    project_id: auth.projectId ?? undefined,
    title: titleHint?.trim() ? `New chat` : `New chat ${scoped.length + 1}`,
    mode: 'chat',
    active_agent_ids: [],
  });
  return chat.id;
}

async function findOrCreateAgentChat(agent: Agent, titleHint?: string): Promise<ChatId | null> {
  const auth = useAuthStore.getState();
  if (!auth.workspaceId) return null;

  const scoped = await listScopedChats();
  const existing = scoped
    .filter((chat) => chat.active_agent_ids?.[0] === agent.id)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (existing) return existing.id;

  const chat = await chatRepo.create({
    workspace_id: auth.workspaceId as WorkspaceId,
    project_id: auth.projectId ?? undefined,
    title: `Chat with ${agent.name}`,
    mode: 'chat',
    active_agent_ids: [agent.id],
  });
  void titleHint;
  return chat.id;
}

/** Switch the UI to a chat without leaving the voice panel. */
export function focusVoiceChat(chatId: ChatId): void {
  const ui = useUIStore.getState();
  ui.setActiveChat(chatId);
  ui.setRoute('chat');
  ui.setChatMode('chat');
}

/**
 * Resolve where a voice utterance should land.
 * Default: Jarvis chat. Specialist chats only when explicitly named.
 */
export async function resolveVoiceChatTarget(utterance: string): Promise<VoiceChatTarget | null> {
  const text = utterance.trim();
  if (!text) return null;

  const explicitSlug = detectExplicitVoiceAgentSlug(text);
  if (explicitSlug) {
    const agent = findAgentBySlug(explicitSlug);
    if (!agent) {
      const chatId = await ensureJarvisChatForVoice(text);
      if (!chatId) return null;
      return { chatId, messageText: text };
    }
    const chatId = await findOrCreateAgentChat(agent, text);
    if (!chatId) return null;
    return {
      chatId,
      messageText: voiceMessageTextForAgentRoute(text, explicitSlug),
      agentId: agent.id,
      mentionedAgentIds: [agent.id],
    };
  }

  const chatId = await ensureJarvisChatForVoice(text);
  if (!chatId) return null;
  return { chatId, messageText: text };
}
