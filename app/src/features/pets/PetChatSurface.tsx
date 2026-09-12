import { ChatBotanicalBackground } from '@/features/chat/ChatBotanicalBackground';
/**
 * Real VibeSpace chat surface for the Pet mini-panel.
 * Uses ChatThread + Composer — same Dexie threads and AI runtime.
 *
 * Panel selection is independent of the main app's activeChatId. Clicking a
 * mini-panel tab must NOT call setActiveChat — that was hijacking the main
 * workspace (and TabStrip project reconciliation made it look like random
 * chats were opening/spawning behind the panel).
 */
import * as React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChatThread } from '@/features/chat/ChatThread';
import { Composer } from '@/features/chat/Composer';
import { WarmChatWelcome } from '@/features/chat/WarmChatWelcome';
import { TokenBossCinematic } from '@/features/chat/token-boss/TokenBossCinematic';
import { chatRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { MessageSquarePlus, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { usePetPresentationStore } from './petPresentationStore';
import { cn } from '@/lib/utils';
import type { ChatId, ProjectId, WorkspaceId } from '@/types/common';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import {
  createPermanentDeleteAuthority,
  type PermanentDeleteAuthority,
  type PermanentDeleteReceipt,
  type PermanentDeleteRequest,
} from '@/features/chat/permanentDeleteAuthority';
import { createJarvisChatIntentStore } from '@/features/chat/jarvisChatIntent';

type PendingDelete = Readonly<{
  id: string;
  title: string;
  expectedAccountId: string;
  expectedWorkspaceId: string;
  expectedProjectId: string | null;
  targetProjectId: string | null;
  targetUpdatedAt: number;
  authority: PermanentDeleteAuthority;
  request: PermanentDeleteRequest;
  receipt: PermanentDeleteReceipt;
}>;

export function PetChatSurface({ className }: { className?: string }) {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const accountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? null);
  const panelActiveChatId = usePetPresentationStore((s) => s.panelActiveChatId);
  const setPanelActiveChatId = usePetPresentationStore((s) => s.setPanelActiveChatId);
  const registerChat = usePetPresentationStore((s) => s.registerChat);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [pendingDelete, setPendingDelete] = React.useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const deletionSessionId = React.useId();
  const allChats = useLiveQuery(
    async () => {
      if (!workspaceId) return [];
      return chatRepo.list({ workspace_id: workspaceId, archived: false });
    },
    [workspaceId],
    [],
  );

  const workspaceChats = allChats ?? [];
  const workspaceChatIds = workspaceChats.map((chat) => String(chat.id));

  // Trust panel selection even when the live list has not caught up yet
  // (e.g. right after create). Only seed a default when nothing is selected.
  const firstChatId = workspaceChatIds[0] ?? null;
  const activeId = panelActiveChatId ?? firstChatId;

  React.useEffect(() => {
    if (panelActiveChatId == null && firstChatId) {
      setPanelActiveChatId(firstChatId);
    }
  }, [panelActiveChatId, firstChatId, setPanelActiveChatId]);

  /** Create a chat for the panel only — never steals main app focus. */
  const createNewOnPanel = async () => {
    if (!workspaceId) return;
    const chat = await chatRepo.create({
      workspace_id: workspaceId as WorkspaceId,
      project_id: (projectId as ProjectId | null) ?? undefined,
      title: 'New chat',
      mode: 'chat',
      active_agent_ids: [],
    });
    const id = String(chat.id);
    registerChat(id, 'pet-mini-panel');
    setPanelActiveChatId(id);
  };

  const beginRename = (chatId: string, title: string) => {
    setPanelActiveChatId(chatId);
    setRenameValue(title);
    setRenamingId(chatId);
  };

  const finishRename = async () => {
    if (!renamingId) return;
    const nextTitle = renameValue.trim();
    const chatId = renamingId;
    setRenamingId(null);
    if (!nextTitle) return;
    await chatRepo.update(chatId as ChatId, { title: nextTitle });
  };

  const requestDelete = (id: string, title: string) => {
    if (!accountId || !workspaceId) return;
    const target = workspaceChats.find((chat) => String(chat.id) === id);
    if (!target || String(target.workspace_id) !== String(workspaceId)) return;
    const targetProjectId = target.project_id ? String(target.project_id) : null;
    const request = { operation: 'delete-chat' as const, resourceIds: [id] };
    const authority = createPermanentDeleteAuthority({
      scope: {
        accountId,
        workspaceId: String(workspaceId),
        projectId: targetProjectId,
        sessionId: deletionSessionId,
      },
    });
    setPendingDelete({
      id,
      title,
      expectedAccountId: accountId,
      expectedWorkspaceId: String(workspaceId),
      expectedProjectId: projectId ? String(projectId) : null,
      targetProjectId,
      targetUpdatedAt: target.updated_at,
      authority,
      request,
      receipt: authority.issue(request),
    });
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    const { id } = pendingDelete;
    setDeleting(true);
    try {
      const liveAuth = useAuthStore.getState();
      const liveAccountId = resolveAccountIdentity(liveAuth)?.accountId ?? '';
      const liveWorkspaceId = String(liveAuth.workspaceId ?? '');
      if (
        liveAccountId !== pendingDelete.expectedAccountId ||
        liveWorkspaceId !== pendingDelete.expectedWorkspaceId ||
        (liveAuth.projectId ? String(liveAuth.projectId) : null) !== pendingDelete.expectedProjectId
      ) {
        throw new Error('pet_chat_delete_scope_changed');
      }
      const target = await chatRepo.getById(id as ChatId);
      const targetProjectId = target?.project_id ? String(target.project_id) : null;
      if (
        !target ||
        String(target.workspace_id) !== pendingDelete.expectedWorkspaceId ||
        targetProjectId !== pendingDelete.targetProjectId ||
        target.updated_at !== pendingDelete.targetUpdatedAt
      ) {
        throw new Error('pet_chat_delete_target_scope_changed');
      }
      const authorized = pendingDelete.authority.consume(
        pendingDelete.receipt,
        {
          accountId: liveAccountId,
          workspaceId: liveWorkspaceId,
          projectId: targetProjectId,
          sessionId: deletionSessionId,
        },
        pendingDelete.request,
      );
      if (!authorized) throw new Error('pet_chat_delete_authority_rejected');
      const outcome = await chatRepo.deleteAuthorized(id as ChatId, {
        expectedAccountId: pendingDelete.expectedAccountId,
        expectedWorkspaceId: pendingDelete.expectedWorkspaceId,
        expectedProjectId: pendingDelete.targetProjectId,
        expectedUpdatedAt: pendingDelete.targetUpdatedAt,
        getActiveAccountId: () =>
          resolveAccountIdentity(useAuthStore.getState())?.accountId ?? null,
        getActiveWorkspaceId: () => {
          const active = useAuthStore.getState().workspaceId;
          return active ? String(active) : null;
        },
      });
      createJarvisChatIntentStore(window.localStorage).reconcileDeleted(
        {
          accountId: pendingDelete.expectedAccountId,
          workspaceId: pendingDelete.expectedWorkspaceId,
          projectId: outcome.deletedProjectId,
        },
        [id],
      );
      const remaining = workspaceChatIds.filter((chatId) => chatId !== id);
      const nextPanel = panelActiveChatId === id ? (remaining[0] ?? null) : panelActiveChatId;
      setPanelActiveChatId(nextPanel);
      // If main still pointed at the deleted chat, park it on a remaining one
      // so the main surface does not render a missing thread.
      const mainActive = useUIStore.getState().activeChatId;
      if (mainActive === id) {
        useUIStore.getState().setActiveChat(remaining[0] ?? null);
      }
      setPendingDelete(null);
    } catch (err) {
      toast.error('Could not delete chat', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={cn('relative flex h-full min-h-0 min-w-0 flex-col gap-2', className)}
      data-pet-chat-surface="true"
    >
      <div
        className="flex min-h-6 min-w-0 shrink-0 items-center gap-0.5"
        data-pet-chat-toolbar="true"
      >
        <Button
          size="sm"
          variant="secondary"
          className="h-6 shrink-0 px-1.5 text-[10px] leading-none"
          onClick={() => void createNewOnPanel()}
          aria-label="New chat"
          title="New chat"
        >
          <MessageSquarePlus className="h-3 w-3" />
          <span data-pet-compact-label>New</span>
        </Button>
        <div
          className="pet-chat-tab-strip flex min-w-0 flex-1 gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Chats"
        >
          {workspaceChatIds.map((id) => {
            const row = workspaceChats.find((chat) => String(chat.id) === id);
            const title = row?.title?.trim() || 'Untitled chat';
            if (renamingId === id) {
              return (
                <input
                  key={id}
                  autoFocus
                  className="pet-chat-rename-input h-7 min-w-[7rem] max-w-40 rounded-md border border-accent-copper/50 bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-accent-copper/30"
                  aria-label={`Rename ${title}`}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void finishRename()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void finishRename();
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                />
              );
            }
            const selected = id === activeId;
            return (
              <div
                key={id}
                role="tab"
                tabIndex={0}
                aria-selected={selected}
                aria-label={`Open chat ${title}`}
                title={`${title} — double-click to rename`}
                data-chat-id={id}
                data-pet-chat-tab="true"
                className={cn(
                  'pet-chat-tab group inline-flex h-6 max-w-[8.5rem] min-w-[3.5rem] shrink-0 items-center gap-0.5 rounded-md border px-1 text-[10px] leading-none',
                  selected
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border bg-transparent text-foreground hover:bg-muted/60',
                )}
                onClick={() => {
                  // Panel-only selection. Do not touch main app activeChatId.
                  setPanelActiveChatId(id);
                }}
                onDoubleClick={() => beginRename(id, title)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPanelActiveChatId(id);
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate px-0.5">{title}</span>
                <button
                  type="button"
                  className="pet-chat-tab-close inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm opacity-70 hover:bg-black/15 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Delete chat ${title}`}
                  title="Delete chat"
                  data-testid={`pet-chat-delete-${id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDelete(id, title);
                  }}
                >
                  <X className="h-2.5 w-2.5" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="pet-chat-canvas flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
        data-pet-chat-workspace="true"
        data-token-boss-host="true"
      >
        {activeId ? (
          <>
            <div
              className="chat-pane-conversation relative min-h-0 flex-1 overflow-hidden"
              data-pet-chat-thread-host="true"
            >
              <ChatBotanicalBackground chatId={String(activeId)} />
              <WarmChatWelcome chatId={String(activeId)} compact />
              <ChatThread chatId={activeId} compact />
            </div>
            <Composer chatId={activeId} compact />
            {/* Sibling of composer so the cinematic covers the full chat box, including typing. */}
            <TokenBossCinematic chatId={String(activeId)} compact />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-secondary text-muted-foreground">
              No chats yet. Start a conversation here.
            </p>
          </div>
        )}
      </div>

      {pendingDelete ? (
        <div
          className="pet-chat-delete-confirm absolute inset-0 z-20 flex items-center justify-center bg-background/85 p-3 backdrop-blur-sm [html[data-theme=monochrome]_&]:backdrop-blur-none"
          data-testid="pet-chat-delete-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm delete chat"
        >
          <div className="pet-chat-delete-confirm-card flex w-full max-w-[16rem] flex-col gap-3 rounded-xl border border-border bg-panel p-3 shadow-2xl">
            <p className="text-[11px] leading-relaxed text-foreground">
              Delete <span className="font-semibold">“{pendingDelete.title}”</span>? This removes
              the chat and its messages. You must confirm.
            </p>
            <div className="flex justify-end gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                disabled={deleting}
                onClick={() => {
                  pendingDelete.authority.revoke();
                  setPendingDelete(null);
                }}
                data-testid="pet-chat-delete-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 bg-destructive px-2 text-[11px] text-destructive-foreground hover:bg-destructive/90"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                data-testid="pet-chat-delete-confirm-btn"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
