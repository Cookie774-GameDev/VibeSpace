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
import { findProtectedJarvisAgent, isProtectedJarvisAgent } from '@/lib/jarvis/identity';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { captureSyncQueueOwner } from '@/lib/cloudSyncQueueOwner';
import {
  createJarvisChatIntentStore,
  selectJarvisChatForIntent,
  type JarvisChatScope,
} from '@/features/chat/jarvisChatIntent';
import { resolveChatBackendAffinity } from '@/lib/ai/backend/chatBackend';
import type { VoiceAgentProvider } from './voiceProviderSelection';
import { isVoiceConversationInScope } from './voiceTaskCoordinator';

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
  if (!boundId) return findProtectedJarvisAgent(Object.values(agents)) !== undefined;
  const bound = agents[boundId];
  return Boolean(bound && isProtectedJarvisAgent(bound));
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

export function voiceMessageTextForAgentRoute(utterance: string, slug: string): string {
  const text = utterance.trim();
  const intent = IntentClassifier.classify(text);
  if (intent.intent === 'agent_route' && intent.slots.query?.trim()) {
    return intent.slots.query.trim();
  }

  const atMatch = new RegExp(`^@${slug}\\s+`, 'i').exec(text);
  if (atMatch) return text.slice(atMatch[0].length).trim() || text;

  const dictMatch = DICTATION_AGENT_RX.exec(text);
  if (dictMatch) {
    return (
      text
        .slice(dictMatch[0].length)
        .replace(/^[\s,:.-]+/, '')
        .trim() || text
    );
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

async function listScopedChats(
  workspaceId: WorkspaceId,
  projectId: ProjectId | null,
): Promise<Chat[]> {
  const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
  return scopedChats(rows, projectId);
}

const voiceChatInflight = new Map<string, Promise<ChatId | null>>();

function runVoiceChatSingleFlight(key: string, operation: () => Promise<ChatId | null>) {
  const active = voiceChatInflight.get(key);
  if (active) return active;
  const pending = operation().finally(() => {
    if (voiceChatInflight.get(key) === pending) voiceChatInflight.delete(key);
  });
  voiceChatInflight.set(key, pending);
  return pending;
}

function voiceScopeIsCurrent(input: {
  accountId: string;
  workspaceId: WorkspaceId;
  projectId: ProjectId | null;
}): boolean {
  const live = useAuthStore.getState();
  return (
    resolveAccountIdentity(live)?.accountId === input.accountId &&
    String(live.workspaceId ?? '') === String(input.workspaceId) &&
    String(live.projectId ?? '') === String(input.projectId ?? '')
  );
}

function syncOwnerMatchesAccount(
  identity: NonNullable<ReturnType<typeof resolveAccountIdentity>>,
  owner: ReturnType<typeof captureSyncQueueOwner>,
): boolean {
  return identity.source === 'supabase'
    ? owner.state === 'cloud' && owner.userId === identity.accountId
    : owner.state === 'unbound';
}

/** Most recent Jarvis chat in the active project, or create one. */
export async function ensureJarvisChatForVoice(titleHint?: string): Promise<ChatId | null> {
  const auth = useAuthStore.getState();
  if (!auth.workspaceId) return null;
  const identity = resolveAccountIdentity(auth);
  if (!identity) return null;

  const intentScope: JarvisChatScope = {
    accountId: identity.accountId,
    workspaceId: String(auth.workspaceId),
    projectId: auth.projectId ? String(auth.projectId) : null,
  };
  const intentStore = createJarvisChatIntentStore(window.localStorage);
  const initialIntent = intentStore.read(intentScope);
  const initialIntentKey = JSON.stringify(initialIntent);
  const captured = {
    accountId: identity.accountId,
    workspaceId: auth.workspaceId as WorkspaceId,
    projectId: auth.projectId as ProjectId | null,
  };
  const key = JSON.stringify([intentScope, 'jarvis', initialIntent]);
  return runVoiceChatSingleFlight(key, async () => {
    const agents = useAgentStore.getState().agents;
    const protectedJarvis = findProtectedJarvisAgent(Object.values(agents));
    const syncOwner = captureSyncQueueOwner();
    const targetIsCurrent = () =>
      voiceScopeIsCurrent(captured) &&
      syncOwnerMatchesAccount(identity, syncOwner) &&
      JSON.stringify(intentStore.read(intentScope)) === initialIntentKey &&
      findProtectedJarvisAgent(Object.values(useAgentStore.getState().agents))?.id ===
        protectedJarvis?.id;
    if (!protectedJarvis || !targetIsCurrent()) return null;
    const select = async () => {
      const scoped = await listScopedChats(captured.workspaceId, captured.projectId);
      if (!targetIsCurrent()) return { scoped, selection: null };
      const jarvisChats = scoped.filter((chat) => isJarvisChat(chat, agents));
      return {
        scoped,
        selection: selectJarvisChatForIntent(
          intentStore.read(intentScope),
          jarvisChats.map((chat) => ({ id: String(chat.id), updatedAt: chat.updated_at })),
        ),
      };
    };
    let resolved = await select();
    if (!resolved.selection) return null;
    if (resolved.selection.kind === 'use-chat') return resolved.selection.chatId as ChatId;
    if (resolved.selection.kind !== 'create-chat') return null;

    // Re-read immediately before creation so a chat created by another caller/tab wins.
    resolved = await select();
    if (!resolved.selection) return null;
    if (resolved.selection.kind === 'use-chat') return resolved.selection.chatId as ChatId;
    if (resolved.selection.kind !== 'create-chat' || !targetIsCurrent()) return null;
    const chat = await chatRepo.createAuthorized(
      {
        workspace_id: captured.workspaceId,
        project_id: captured.projectId ?? undefined,
        title: titleHint?.trim() ? `New chat` : `New chat ${resolved.scoped.length + 1}`,
        mode: 'chat',
        active_agent_ids: [protectedJarvis.id],
      },
      syncOwner,
      targetIsCurrent,
    );
    if (!chat || !targetIsCurrent()) return null;
    intentStore.recordCreatedPrimary(intentScope, String(chat.id));
    return chat.id;
  });
}

/** A voice Main Agent chat must be bound to its requested runtime before its first user turn. */
export async function ensureJarvisChatForProvider(
  provider: VoiceAgentProvider,
  titleHint?: string,
  options: { freshVoiceConversation?: boolean; openingId?: string } = {},
): Promise<ChatId | null> {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  if (!auth.workspaceId || !identity) return null;
  const captured = {
    accountId: identity.accountId,
    workspaceId: auth.workspaceId as WorkspaceId,
    projectId: auth.projectId as ProjectId | null,
  };
  const key = JSON.stringify([
    captured,
    'jarvis-provider',
    provider,
    options.freshVoiceConversation ? options.openingId : 'reuse',
  ]);
  return runVoiceChatSingleFlight(key, async () => {
    const protectedJarvis = findProtectedJarvisAgent(
      Object.values(useAgentStore.getState().agents),
    );
    const syncOwner = captureSyncQueueOwner();
    const targetIsCurrent = () =>
      voiceScopeIsCurrent(captured) &&
      syncOwnerMatchesAccount(identity, syncOwner) &&
      findProtectedJarvisAgent(Object.values(useAgentStore.getState().agents))?.id ===
        protectedJarvis?.id;
    if (!protectedJarvis || !targetIsCurrent()) return null;
    const find = async () => {
      const scoped = await listScopedChats(captured.workspaceId, captured.projectId);
      if (options.freshVoiceConversation) return { scoped, existing: undefined };
      const providerChats = scoped
        .filter((chat) => isJarvisChat(chat, useAgentStore.getState().agents))
        .filter((chat) => {
          try {
            return (
              resolveChatBackendAffinity(chat.backend_affinity, {
                hasCommittedUserMessage: false,
                chatCreatedAt: chat.created_at,
              }).backend === provider
            );
          } catch {
            return false;
          }
        });
      const voiceScope = {
        accountId: captured.accountId,
        workspaceId: String(captured.workspaceId),
        projectId: captured.projectId ? String(captured.projectId) : null,
      };
      // A newer ordinary Jarvis chat must not replace the user's voice
      // conversation. The title fallback keeps pre-index voice chats resumable.
      const indexedVoiceChats = providerChats.filter((chat) =>
        isVoiceConversationInScope(voiceScope, String(chat.id)),
      );
      const existing = (
        indexedVoiceChats.length
          ? indexedVoiceChats
          : providerChats.filter((chat) => /^Jarvis Voice(?:\s|$)/iu.test(chat.title))
      ).sort((a, b) => b.updated_at - a.updated_at)[0];
      return { scoped, existing };
    };
    let resolved = await find();
    if (!targetIsCurrent()) return null;
    if (resolved.existing) return resolved.existing.id;
    resolved = await find();
    if (!targetIsCurrent()) return null;
    if (resolved.existing) return resolved.existing.id;
    const chat = await chatRepo.createAuthorized(
      {
        workspace_id: captured.workspaceId,
        project_id: captured.projectId ?? undefined,
        title: options.freshVoiceConversation
          ? `Jarvis Voice ${new Date().toLocaleString()}`
          : titleHint?.trim()
            ? 'New chat'
            : `New chat ${resolved.scoped.length + 1}`,
        mode: 'chat',
        active_agent_ids: [protectedJarvis.id],
        backend_affinity: {
          version: 1,
          backend: provider,
          locked: false,
          selectedAt: Date.now(),
        },
      },
      syncOwner,
      targetIsCurrent,
    );
    return chat && targetIsCurrent() ? chat.id : null;
  });
}

async function findOrCreateAgentChat(agent: Agent, titleHint?: string): Promise<ChatId | null> {
  const auth = useAuthStore.getState();
  if (!auth.workspaceId) return null;

  const identity = resolveAccountIdentity(auth);
  if (!identity) return null;
  const captured = {
    accountId: identity.accountId,
    workspaceId: auth.workspaceId as WorkspaceId,
    projectId: auth.projectId as ProjectId | null,
  };
  const key = JSON.stringify([captured, 'agent', String(agent.id)]);
  return runVoiceChatSingleFlight(key, async () => {
    const syncOwner = captureSyncQueueOwner();
    const targetIsCurrent = () =>
      voiceScopeIsCurrent(captured) &&
      syncOwnerMatchesAccount(identity, syncOwner) &&
      useAgentStore.getState().agents[agent.id]?.slug === agent.slug;
    const find = async () => {
      const scoped = await listScopedChats(captured.workspaceId, captured.projectId);
      const existing = scoped
        .filter((chat) => chat.active_agent_ids?.[0] === agent.id)
        .sort((a, b) => b.updated_at - a.updated_at)[0];
      return { scoped, existing };
    };
    let resolved = await find();
    if (!targetIsCurrent()) return null;
    if (resolved.existing) return resolved.existing.id;
    resolved = await find();
    if (!targetIsCurrent()) return null;
    if (resolved.existing) return resolved.existing.id;
    const chat = await chatRepo.createAuthorized(
      {
        workspace_id: captured.workspaceId,
        project_id: captured.projectId ?? undefined,
        title: `Chat with ${agent.name}`,
        mode: 'chat',
        active_agent_ids: [agent.id],
      },
      syncOwner,
      targetIsCurrent,
    );
    void titleHint;
    return chat && targetIsCurrent() ? chat.id : null;
  });
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
