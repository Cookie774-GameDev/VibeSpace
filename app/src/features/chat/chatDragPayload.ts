import type { Chat } from '@/types/chat';
import type { ChatId } from '@/types/common';

export const VIBESPACE_CHAT_MIME = 'application/x-vibespace-chat';
export const CHAT_SEND_CONTEXT_EVENT = 'vibespace:chat-send-context';
export const CHAT_OPEN_BESIDE_EVENT = 'vibespace:chat-open-beside';

export type ChatDragPayloadV1 = Readonly<{
  version: 1;
  chatId: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
}>;

type ChatDragDataTransfer = Pick<DataTransfer, 'getData' | 'setData'>;

const CHAT_DRAG_KEYS = ['version', 'chatId', 'workspaceId', 'projectId', 'title'] as const;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === CHAT_DRAG_KEYS.length &&
    CHAT_DRAG_KEYS.every((key, index) => keys[index] === [...CHAT_DRAG_KEYS].sort()[index])
  );
}

function stableId(value: unknown): value is string {
  return typeof value === 'string' && STABLE_ID.test(value);
}

function parsePayload(value: unknown): ChatDragPayloadV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record) || record.version !== 1) return null;
  if (!stableId(record.chatId) || !stableId(record.workspaceId)) return null;
  if (record.projectId !== null && !stableId(record.projectId)) return null;
  if (typeof record.title !== 'string' || !record.title.trim() || record.title.length > 512)
    return null;
  return Object.freeze({
    version: 1,
    chatId: record.chatId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    title: record.title.trim(),
  });
}

export function writeChatDragPayload(
  dataTransfer: ChatDragDataTransfer,
  chat: Chat,
): ChatDragPayloadV1 {
  const payload = Object.freeze({
    version: 1 as const,
    chatId: String(chat.id),
    workspaceId: String(chat.workspace_id),
    projectId: chat.project_id ? String(chat.project_id) : null,
    title: (chat.title || 'Untitled chat').trim() || 'Untitled chat',
  });
  dataTransfer.setData(VIBESPACE_CHAT_MIME, JSON.stringify(payload));
  return payload;
}

export function readChatDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): ChatDragPayloadV1 | null {
  const raw = dataTransfer.getData(VIBESPACE_CHAT_MIME);
  if (!raw) return null;
  try {
    return parsePayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type AcceptedChatDropResult =
  | Readonly<{ ok: true; chat: Chat }>
  | Readonly<{
      ok: false;
      reason: 'invalid_payload' | 'same_chat' | 'chat_unavailable' | 'access_denied';
    }>;

export async function resolveAcceptedChatDrop(
  input: Readonly<{ payload: ChatDragPayloadV1; targetChatId: string; purpose?: 'reference' }>,
  deps: Readonly<{
    getChat: (id: ChatId) => Promise<Chat | undefined>;
    canAccess: (source: Chat, target: Chat) => boolean;
  }>,
): Promise<AcceptedChatDropResult> {
  const payload = parsePayload(input.payload);
  if (!payload) return { ok: false, reason: 'invalid_payload' };
  if (payload.chatId === input.targetChatId && input.purpose !== 'reference')
    return { ok: false, reason: 'same_chat' };

  const [source, target] = await Promise.all([
    deps.getChat(payload.chatId as ChatId),
    deps.getChat(input.targetChatId as ChatId),
  ]);
  if (!source || !target) return { ok: false, reason: 'chat_unavailable' };
  if (
    String(source.workspace_id) !== payload.workspaceId ||
    (input.purpose !== 'reference' &&
      (source.project_id ? String(source.project_id) : null) !== payload.projectId)
  ) {
    return { ok: false, reason: 'chat_unavailable' };
  }
  if (!deps.canAccess(source, target)) return { ok: false, reason: 'access_denied' };
  return { ok: true, chat: source };
}
