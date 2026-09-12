import { chatRepo, messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { captureSyncQueueOwner } from '@/lib/cloudSyncQueueOwner';
import type { ChatId } from '@/types/common';
import type { ChatDragPayloadV1 } from './chatDragPayload';
import { projectChatHandoff, type ChatHandoffProjectionV1 } from './chatHandoffProjection';
import type { QueuedChatMessage } from './composerQueuePolicy';

export const QUEUE_SIDE_CHAT_EVENT = 'vibespace:queue-side-chat';
export type QueueSideChatRequest = {
  sourceId: string;
  create: () => Promise<ChatDragPayloadV1>;
  resolve: (ok: boolean) => void;
};
type Sender = (message: QueuedChatMessage, projection: ChatHandoffProjectionV1) => Promise<boolean>;
const senders = new Map<string, Sender>();
const targets = new Map<string, ChatDragPayloadV1>();
export function registerQueueSideSender(id: string, sender: Sender) {
  senders.set(id, sender);
  return () => {
    if (senders.get(id) === sender) senders.delete(id);
  };
}

export async function openQueuedSideChat(
  sourceId: string,
  message: QueuedChatMessage,
): Promise<boolean> {
  const auth = useAuthStore.getState();
  const account = resolveAccountIdentity(auth)?.accountId;
  const scope = () => {
    const current = useAuthStore.getState();
    return (
      resolveAccountIdentity(current)?.accountId === account &&
      current.workspaceId === auth.workspaceId &&
      current.projectId === auth.projectId
    );
  };
  if (!account || !scope()) throw new Error('Return to the original account and workspace.');
  const source = await chatRepo.getById(sourceId as ChatId);
  if (
    !source ||
    source.archived ||
    source.workspace_id !== auth.workspaceId ||
    String(source.project_id ?? '') !== String(auth.projectId ?? '')
  )
    throw new Error('Source chat is unavailable in this workspace.');
  const projection = projectChatHandoff({
    sourceChat: source,
    messages: await messageRepo.listByChat(source.id),
  });
  if (!scope()) throw new Error('The active account changed.');
  const key = `${account}:${sourceId}:${message.id}`;
  let target = targets.get(key);
  const opened = await new Promise<boolean>((resolve) => {
    let active = true;
    const timeout = window.setTimeout(() => {
      active = false;
      resolve(false);
    }, 15000);
    const request: QueueSideChatRequest = {
      sourceId,
      create: async () => {
        if (!active || !scope())
          throw new Error('The side-chat request expired or account changed.');
        if (!target) {
          const row = await chatRepo.createAuthorized(
            {
              workspace_id: source.workspace_id,
              project_id: source.project_id,
              title: message.text.slice(0, 48) || 'Side chat',
              mode: 'chat',
              active_agent_ids: [],
              connection: source.connection,
            },
            captureSyncQueueOwner(),
            () => active && scope(),
          );
          if (!row) throw new Error('Could not create side chat.');
          target = {
            version: 1,
            chatId: String(row.id),
            workspaceId: String(row.workspace_id),
            projectId: row.project_id ? String(row.project_id) : null,
            title: row.title,
          };
          targets.set(key, target);
        }
        return target;
      },
      resolve: (ok) => {
        clearTimeout(timeout);
        resolve(ok);
      },
    };
    window.dispatchEvent(new CustomEvent(QUEUE_SIDE_CHAT_EVENT, { detail: request }));
  });
  if (!opened || !target || !scope())
    throw new Error(
      'Could not open side chat. Keep fewer than four panes open and try again from the main chat.',
    );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!scope()) throw new Error('The active account changed.');
    const sender = senders.get(target.chatId);
    if (sender) {
      const accepted = await sender(message, projection);
      if (accepted) targets.delete(key);
      return accepted;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Side chat is still loading. Your message remains queued; try again.');
}
