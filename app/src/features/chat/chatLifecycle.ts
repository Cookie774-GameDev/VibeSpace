/**
 * Chat bootstrapping — always keep a conversation ready for the user.
 */
import { db, chatRepo, messageRepo } from '@/lib/db';
import type { ChatId, MessageId, ProjectId, WorkspaceId } from '@/types/common';
import type { Message } from '@/types';
import { newMessageId } from '@/lib/ids';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { captureSyncQueueOwner, type SyncQueueOwnerSnapshot } from '@/lib/cloudSyncQueueOwner';
import type { AccountIdentity } from '@/lib/accountIdentity';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { createJarvisChatIntentStore, selectJarvisChatForIntent } from './jarvisChatIntent';
import {
  requireHealthyLocalChatStorage,
  runLocalChatStorageOperation,
} from '@/lib/doctor/storageDoctor';

export function isDefaultChatTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  return (
    t.length === 0 || t === 'New chat' || /^New chat( \d+)?$/i.test(t) || t.startsWith('Chat with ')
  );
}

/** Derive a short tab title from the first useful sentence in text. */
export function deriveChatTitle(text: string): string {
  if (!text) return '';
  let stripped = text.replace(/```[\s\S]*?```/g, ' ');
  stripped = stripped.replace(/`([^`]+)`/g, '$1');
  stripped = stripped.replace(/^\s*[#>*\-+\d.]+\s+/gm, '');
  stripped = stripped.replace(/\s+/g, ' ').trim();
  if (!stripped) return '';

  const sentenceMatch = /^[^.!?\n]{3,}[.!?]/.exec(stripped);
  let title = sentenceMatch ? sentenceMatch[0] : stripped;
  title = title.replace(/[.!?]+$/, '').trim();
  if (title.length > 48) {
    title = `${title.slice(0, 47).trimEnd()}…`;
  }
  if (title.length < 3) return '';
  return title;
}

export interface EnsureActiveChatOptions {
  /** Force a brand-new chat even when others exist. */
  forceNew?: boolean;
  /** Initial title when creating a chat. */
  title?: string;
  /** Used to derive a title when `title` is omitted (e.g. first user message). */
  titleHint?: string;
  /** Navigate to the chat route after ensuring. Default true. */
  navigateToChat?: boolean;
}

export interface CreateChatInScopeOptions {
  readonly accountId: string;
  readonly accountSource: AccountIdentity['source'];
  readonly syncOwner: SyncQueueOwnerSnapshot;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly title?: string;
  readonly titleHint?: string;
  readonly navigateToChat?: boolean;
  readonly isScopeCurrent: () => boolean;
  readonly beforeActivate: (chatId: string) => boolean;
}

export async function createChatInScope(options: CreateChatInScopeOptions): Promise<ChatId | null> {
  await requireHealthyLocalChatStorage();
  const ownerMatchesAccount =
    options.accountSource === 'supabase'
      ? options.syncOwner.state === 'cloud' && options.syncOwner.userId === options.accountId
      : options.syncOwner.state === 'unbound';
  if (!ownerMatchesAccount || !options.isScopeCurrent()) return null;

  const rows = await db.chats
    .where('workspace_id')
    .equals(options.workspaceId as WorkspaceId)
    .toArray();
  const scoped = options.projectId
    ? rows.filter((chat) => String(chat.project_id ?? '') === options.projectId)
    : rows.filter((chat) => !chat.project_id);
  const hintedTitle = options.titleHint ? deriveChatTitle(options.titleHint) : '';
  const title = options.title?.trim() || hintedTitle || `New chat ${scoped.length + 1}`;
  const chat = await chatRepo.createAuthorized(
    {
      workspace_id: options.workspaceId as WorkspaceId,
      project_id: options.projectId ? (options.projectId as ProjectId) : undefined,
      title,
      mode: 'chat',
      active_agent_ids: [],
    },
    options.syncOwner,
    () => ownerMatchesAccount && options.isScopeCurrent(),
  );

  if (!chat || !options.beforeActivate(String(chat.id))) return null;
  createJarvisChatIntentStore(window.localStorage).recordCreatedPrimary(
    {
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
    },
    String(chat.id),
  );
  const ui = useUIStore.getState();
  ui.setActiveChat(chat.id);
  if (options.navigateToChat !== false) {
    ui.setRoute('chat');
    ui.setChatMode('chat');
  }
  return chat.id;
}

const ensureInflight = new Map<string, Promise<ChatId | null>>();

function chatMatchesScope(
  chat: { workspace_id: WorkspaceId; project_id?: ProjectId | null },
  workspaceId: WorkspaceId,
  projectId: ProjectId | null,
): boolean {
  return (
    String(chat.workspace_id) === String(workspaceId) &&
    String(chat.project_id ?? '') === String(projectId ?? '')
  );
}

function ensureScopeKey(options: EnsureActiveChatOptions): string {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  const scope =
    identity && auth.workspaceId
      ? {
          accountId: identity.accountId,
          workspaceId: String(auth.workspaceId),
          projectId: auth.projectId ? String(auth.projectId) : null,
        }
      : null;
  const intent = scope
    ? createJarvisChatIntentStore(window.localStorage).read(scope)
    : { version: 1 as const, intent: { kind: 'reuse-primary' as const } };
  return JSON.stringify([
    scope?.accountId ?? null,
    scope?.workspaceId ?? null,
    scope?.projectId ?? null,
    intent,
    options.title ?? null,
    options.titleHint ?? null,
    options.navigateToChat !== false,
  ]);
}

async function ensureActiveChatInternal(
  options: EnsureActiveChatOptions = {},
  expectedScopeKey?: string,
): Promise<ChatId | null> {
  return runLocalChatStorageOperation(async () => {
    const ui = useUIStore.getState();
    const auth = useAuthStore.getState();
    const navigate = options.navigateToChat !== false;
    const identity = resolveAccountIdentity(auth);
    const intentScope =
      identity && auth.workspaceId
        ? {
            accountId: identity.accountId,
            workspaceId: String(auth.workspaceId),
            projectId: auth.projectId ? String(auth.projectId) : null,
          }
        : null;
    const intentStore = createJarvisChatIntentStore(window.localStorage);
    const intentState = intentScope
      ? intentStore.read(intentScope)
      : ({ version: 1, intent: { kind: 'reuse-primary' } } as const);
    if (expectedScopeKey && ensureScopeKey(options) !== expectedScopeKey) return null;
    const scopeIsCurrent = () => {
      const live = useAuthStore.getState();
      const liveIdentity = resolveAccountIdentity(live);
      return Boolean(
        identity &&
        liveIdentity?.accountId === identity.accountId &&
        String(live.workspaceId ?? '') === String(auth.workspaceId ?? '') &&
        String(live.projectId ?? '') === String(auth.projectId ?? ''),
      );
    };
    const operationIsCurrent = () =>
      scopeIsCurrent() && (!expectedScopeKey || ensureScopeKey(options) === expectedScopeKey);
    const activeChatId = ui.activeChatId;

    const activeMatchesIntent =
      intentState.intent.kind !== 'invalid' &&
      intentState.intent.kind !== 'explicit-new' &&
      (intentState.intent.kind !== 'specific-chat' ||
        intentState.intent.chatId === String(activeChatId)) &&
      (intentState.intent.kind !== 'reuse-primary' ||
        !intentState.primaryChatId ||
        intentState.primaryChatId === String(activeChatId));
    if (activeChatId && !options.forceNew && activeMatchesIntent) {
      const existing = await chatRepo.getById(activeChatId as ChatId);
      if (
        existing &&
        auth.workspaceId &&
        chatMatchesScope(existing, auth.workspaceId, auth.projectId) &&
        operationIsCurrent() &&
        useUIStore.getState().activeChatId === activeChatId
      ) {
        return activeChatId as ChatId;
      }
      if (useUIStore.getState().activeChatId !== activeChatId) return null;
    }

    if (!auth.workspaceId) return null;

    const projectId = auth.projectId;
    const rows = await db.chats.where('workspace_id').equals(auth.workspaceId).toArray();
    if (!operationIsCurrent()) return null;
    const scoped = projectId
      ? rows.filter((c) => c.project_id === projectId)
      : rows.filter((c) => !c.project_id);

    if (!options.forceNew) {
      const selection = selectJarvisChatForIntent(
        intentState,
        scoped.map((chat) => ({ id: String(chat.id), updatedAt: chat.updated_at })),
      );
      if (selection.kind === 'unavailable-specific-chat' || selection.kind === 'unavailable-intent')
        return null;
      if (selection.kind === 'create-chat') {
        // Continue to the shared creation path below.
      } else {
        const selected = scoped.find((chat) => String(chat.id) === selection.chatId);
        if (!selected) return null;
        if (!operationIsCurrent()) return null;
        ui.setActiveChat(selected.id);
        if (navigate) {
          ui.setRoute('chat');
          ui.setChatMode('chat');
        }
        return selected.id;
      }
    }

    const hintedTitle = options.titleHint ? deriveChatTitle(options.titleHint) : '';
    const title = options.title?.trim() || hintedTitle || `New chat ${scoped.length + 1}`;

    if (!operationIsCurrent()) return null;
    const syncOwner = captureSyncQueueOwner();
    const ownerMatchesAccount =
      identity?.source === 'supabase'
        ? syncOwner.state === 'cloud' && syncOwner.userId === identity.accountId
        : syncOwner.state === 'unbound';
    const creationIsCurrent = () => ownerMatchesAccount && operationIsCurrent();
    const chat = await chatRepo.createAuthorized(
      {
        workspace_id: auth.workspaceId,
        project_id: projectId ?? undefined,
        title,
        mode: 'chat',
        active_agent_ids: [],
      },
      syncOwner,
      creationIsCurrent,
    );

    if (!chat || !creationIsCurrent()) return null;
    if (intentScope) intentStore.recordCreatedPrimary(intentScope, String(chat.id));

    ui.setActiveChat(chat.id);
    if (navigate) {
      ui.setRoute('chat');
      ui.setChatMode('chat');
    }
    return chat.id;
  });
}

/** Ensure the workspace has an active chat (reuse recent or create). */
export function ensureActiveChat(options: EnsureActiveChatOptions = {}): Promise<ChatId | null> {
  if (options.forceNew) {
    return ensureActiveChatInternal(options, ensureScopeKey(options));
  }
  const key = ensureScopeKey(options);
  const active = ensureInflight.get(key);
  if (active) return active;
  const pending = ensureActiveChatInternal(options, key).finally(() => {
    if (ensureInflight.get(key) === pending) ensureInflight.delete(key);
  });
  ensureInflight.set(key, pending);
  return pending;
}

/** Title for a chat forked from an existing thread. */
export function formatBranchChatTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || 'Chat';
  return base.toLowerCase().startsWith('branch:') ? `${base} · fork` : `Branch: ${base}`;
}

/** Messages from the start of a chat through the branch point (inclusive). */
export function messagesThroughBranchPoint(messages: Message[], messageId: MessageId): Message[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return [];
  return messages.slice(0, index + 1);
}

/**
 * Fork a new chat that copies history up to (and including) `messageId`,
 * then opens it so the user can continue from that point.
 */
export async function branchChatFromMessage(args: {
  chatId: ChatId;
  messageId: MessageId;
  navigateToChat?: boolean;
}): Promise<ChatId> {
  await requireHealthyLocalChatStorage();
  const source = await chatRepo.getById(args.chatId);
  if (!source) throw new Error('Source chat not found');

  const messages = await messageRepo.listByChat(args.chatId);
  const prefix = messagesThroughBranchPoint(messages, args.messageId);
  if (prefix.length === 0) {
    throw new Error('Message not found in this chat');
  }

  const newChat = await chatRepo.create({
    workspace_id: source.workspace_id,
    project_id: source.project_id,
    title: formatBranchChatTitle(source.title),
    mode: source.mode,
    active_agent_ids: [...source.active_agent_ids],
    connection: source.connection,
    backend_affinity: source.backend_affinity,
  });

  const idMap = new Map<MessageId, MessageId>();
  for (const message of prefix) {
    idMap.set(message.id, newMessageId());
  }

  for (const message of prefix) {
    await messageRepo.create({
      id: idMap.get(message.id),
      chat_id: newChat.id,
      role: message.role,
      agent_id: message.agent_id,
      parts: structuredClone(message.parts),
      parent_id:
        message.parent_id && idMap.has(message.parent_id)
          ? idMap.get(message.parent_id)
          : undefined,
      usage: message.usage,
      created_at: message.created_at,
      updated_at: message.updated_at,
    });
  }

  const ui = useUIStore.getState();
  ui.setActiveChat(newChat.id);
  const navigate = args.navigateToChat !== false;
  if (navigate) {
    ui.setRoute('chat');
    ui.setChatMode('chat');
  }

  return newChat.id;
}

/** Rename placeholder tabs from the first user or assistant message. */
const automaticRenameInflight = new Map<ChatId, Promise<void>>();

export function maybeRenameChat(chatId: ChatId, text: string): Promise<void> {
  const title = deriveChatTitle(text);
  if (!title) return Promise.resolve();

  const previous = automaticRenameInflight.get(chatId) ?? Promise.resolve();
  const current = previous.then(async () => {
    try {
      const chat = await chatRepo.getById(chatId);
      if (!chat || !isDefaultChatTitle(chat.title)) return;
      await chatRepo.update(chatId, { title });
    } catch {
      // Automatic naming is best-effort and must never block or reject a response.
    }
  });
  automaticRenameInflight.set(chatId, current);
  void current.then(() => {
    if (automaticRenameInflight.get(chatId) === current) {
      automaticRenameInflight.delete(chatId);
    }
  });
  return current;
}
