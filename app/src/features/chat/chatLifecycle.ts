/**
 * Chat bootstrapping — always keep a conversation ready for the user.
 */
import { db, chatRepo } from '@/lib/db';
import type { ChatId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

export function isDefaultChatTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  return (
    t.length === 0 ||
    t === 'New chat' ||
    /^New chat( \d+)?$/i.test(t) ||
    t.startsWith('Chat with ')
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

let ensureInflight: Promise<ChatId | null> | null = null;

async function ensureActiveChatInternal(
  options: EnsureActiveChatOptions = {},
): Promise<ChatId | null> {
  const ui = useUIStore.getState();
  const auth = useAuthStore.getState();
  const navigate = options.navigateToChat !== false;

  if (ui.activeChatId && !options.forceNew) {
    const existing = await chatRepo.getById(ui.activeChatId as ChatId);
    if (existing) return ui.activeChatId as ChatId;
  }

  if (!auth.workspaceId) return null;

  const projectId = auth.projectId;
  const rows = await db.chats.where('workspace_id').equals(auth.workspaceId).toArray();
  const scoped = projectId
    ? rows.filter((c) => c.project_id === projectId)
    : rows.filter((c) => !c.project_id);

  if (!options.forceNew && scoped.length > 0) {
    const recent = scoped.sort((a, b) => b.updated_at - a.updated_at)[0]!;
    ui.setActiveChat(recent.id);
    if (navigate) {
      ui.setRoute('chat');
      ui.setChatMode('chat');
    }
    return recent.id;
  }

  const hintedTitle = options.titleHint ? deriveChatTitle(options.titleHint) : '';
  const title =
    options.title?.trim() ||
    hintedTitle ||
    `New chat ${scoped.length + 1}`;

  const chat = await chatRepo.create({
    workspace_id: auth.workspaceId,
    project_id: projectId ?? undefined,
    title,
    mode: 'chat',
    active_agent_ids: [],
  });

  ui.setActiveChat(chat.id);
  if (navigate) {
    ui.setRoute('chat');
    ui.setChatMode('chat');
  }
  return chat.id;
}

/** Ensure the workspace has an active chat (reuse recent or create). */
export function ensureActiveChat(options: EnsureActiveChatOptions = {}): Promise<ChatId | null> {
  if (options.forceNew) {
    return ensureActiveChatInternal(options);
  }
  if (!ensureInflight) {
    ensureInflight = ensureActiveChatInternal(options).finally(() => {
      ensureInflight = null;
    });
  }
  return ensureInflight;
}

/** Rename placeholder tabs from the first user or assistant message. */
export async function maybeRenameChat(chatId: ChatId, text: string): Promise<void> {
  const title = deriveChatTitle(text);
  if (!title) return;
  const chat = await chatRepo.getById(chatId);
  if (!chat || !isDefaultChatTitle(chat.title)) return;
  await chatRepo.update(chatId, { title });
}
