import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { chatRepo } from '@/lib/db';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { EmptyChat } from './EmptyChat';
import { ensureActiveChat } from './chatLifecycle';
import { cn, isTauri } from '@/lib/utils';
import {
  dispatchMediaAttach,
  getChatDragKind,
  getChatDropPayload,
  type ChatDropKind,
} from './dropPayload';
import { createNativeChatFileDropHandler } from './nativeFileDrop';
import { OrigamiChatDecor } from './OrigamiChatDecor';
import { MONOCHROME_CHAT_FIXTURE } from './monochromeFixture';
import { TokenBossCinematic } from './token-boss/TokenBossCinematic';
import { WarmChatWelcome } from './WarmChatWelcome';
import { ChatOutputPanel } from './ChatOutputPanel';
import { BrowserGoalStatus } from '@/features/browser/BrowserGoalStatus';
import { BrowserChatHub, resolveChatEngine, useBrowserChatStore } from '@/features/browser-chat';
import { ChatWorkspace, type ChatWorkspaceOpenResult } from './ChatWorkspace';
import {
  addChatPane,
  chatWorkspaceStorageKey,
  clearChatWorkspaceLayout,
  closeChatPane,
  focusChatPane,
  loadChatWorkspaceLayout,
  pruneChatWorkspaceLayout,
  replacePrimaryChatPane,
  saveChatWorkspaceLayout,
  subscribeChatWorkspaceLayout,
  type ChatWorkspaceLayoutV1,
  type ChatWorkspaceScope,
} from './chatWorkspaceLayout';
import { resolveAcceptedChatDrop, type ChatDragPayloadV1 } from './chatDragPayload';
import type { ChatId, ProjectId, WorkspaceId } from '@/types/common';
import type { Message } from '@/types/chat';
import './sakura-chat.css';
import './chat-welcome.css';
import { VibeCheckPanel } from './vibe-check/VibeCheckPanel';

function sameLayout(left: ChatWorkspaceLayoutV1, right: ChatWorkspaceLayoutV1): boolean {
  return (
    left.focusedChatId === right.focusedChatId &&
    left.chatIds.length === right.chatIds.length &&
    left.chatIds.every((chatId, index) => chatId === right.chatIds[index])
  );
}

function VisualFixtureChatSurface({
  activeChatId,
  messages,
}: {
  activeChatId: string;
  messages: readonly Message[];
}) {
  const engine = useBrowserChatStore((state) => resolveChatEngine(state, activeChatId));
  const [outputOpen, setOutputOpen] = useState(false);

  useEffect(() => {
    const onOutput = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: string }>).detail;
      if (detail?.chatId && String(detail.chatId) !== String(activeChatId)) return;
      setOutputOpen(true);
    };
    window.addEventListener('jarvis:chat:output', onOutput as EventListener);
    return () => window.removeEventListener('jarvis:chat:output', onOutput as EventListener);
  }, [activeChatId]);

  if (engine === 'browser' && activeChatId) return <BrowserChatHub chatId={activeChatId} />;
  return (
    <>
      <WarmChatWelcome chatId={String(activeChatId)} />
      <ChatThread chatId={activeChatId} fixtureMessages={messages} />
      <BrowserGoalStatus chatId={String(activeChatId)} />
      <Composer key={String(activeChatId)} chatId={activeChatId} />
      <TokenBossCinematic chatId={String(activeChatId)} />
      <ChatOutputPanel
        chatId={String(activeChatId)}
        open={outputOpen}
        onClose={() => setOutputOpen(false)}
      />
    </>
  );
}

/** Top-level chat route and its persisted one-to-four-pane workspace. */
export function ChatView() {
  const storedActiveChatId = useUIStore((state) => state.activeChatId);
  const setActiveChat = useUIStore((state) => state.setActiveChat);
  const localUserId = useAuthStore((state) => state.localUserId);
  const cloudUserId = useAuthStore((state) => state.cloudSession?.user_id ?? null);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const isVisualEmptyChat = document.documentElement.dataset.monochromeChatState === 'empty-state';
  const visualChatFixture =
    document.documentElement.dataset.monochromeChatFixture === 'chat'
      ? MONOCHROME_CHAT_FIXTURE
      : undefined;
  const activeChatId = visualChatFixture?.activeConversationId ?? storedActiveChatId;
  const [dropKind, setDropKind] = useState<ChatDropKind | null>(null);
  const [ensuringChat, setEnsuringChat] = useState(false);
  const [ensureFailed, setEnsureFailed] = useState(false);

  const scope = useMemo<ChatWorkspaceScope | null>(() => {
    if (!activeChatId) return null;
    return {
      accountId: cloudUserId || localUserId || 'local-account',
      workspaceId: String(workspaceId ?? 'local-workspace'),
      projectId: projectId ? String(projectId) : null,
      primaryChatId: String(activeChatId),
    };
  }, [activeChatId, cloudUserId, localUserId, projectId, workspaceId]);
  const scopeKey = scope
    ? `${chatWorkspaceStorageKey(scope)}:view:${encodeURIComponent(scope.primaryChatId)}`
    : null;
  const [layoutState, setLayoutState] = useState<{
    key: string;
    layout: ChatWorkspaceLayoutV1;
  } | null>(() =>
    scope && scopeKey ? { key: scopeKey, layout: loadChatWorkspaceLayout(scope) } : null,
  );
  const workspaceLayout =
    scope && scopeKey
      ? layoutState?.key === scopeKey
        ? layoutState.layout
        : loadChatWorkspaceLayout(scope)
      : null;
  const layoutRef = useRef(workspaceLayout);
  layoutRef.current = workspaceLayout;
  const activeScopeKeyRef = useRef(scopeKey);
  const operationEpochRef = useRef(0);
  if (activeScopeKeyRef.current !== scopeKey) {
    activeScopeKeyRef.current = scopeKey;
    operationEpochRef.current += 1;
  }

  const accessibleChats = useLiveQuery(
    () =>
      workspaceId
        ? chatRepo
            .list({ workspace_id: workspaceId as WorkspaceId, archived: false })
            .then((rows) =>
              projectId
                ? rows.filter((chat) => chat.project_id === (projectId as ProjectId))
                : rows.filter((chat) => !chat.project_id),
            )
        : Promise.resolve([]),
    [workspaceId, projectId],
  );

  const commitLayout = useCallback(
    (next: ChatWorkspaceLayoutV1) => {
      if (!scope || !scopeKey || activeScopeKeyRef.current !== scopeKey) return false;
      // Pointer release/composer focus can repeat the current selection while
      // canonical drop validation is pending. A no-op must not cancel that drop.
      if (layoutRef.current && sameLayout(layoutRef.current, next)) return true;
      operationEpochRef.current += 1;
      layoutRef.current = next;
      setLayoutState({ key: scopeKey, layout: next });
      saveChatWorkspaceLayout(scope, next);
      return true;
    },
    [scope, scopeKey],
  );

  useEffect(() => {
    if (!scope || !scopeKey) {
      setLayoutState(null);
      return;
    }
    setLayoutState((current) =>
      current?.key === scopeKey
        ? current
        : { key: scopeKey, layout: loadChatWorkspaceLayout(scope) },
    );
  }, [scope, scopeKey]);

  useEffect(() => {
    if (!scope || !scopeKey) return;
    return subscribeChatWorkspaceLayout(scope, (layout) => {
      if (activeScopeKeyRef.current !== scopeKey) return;
      if (layoutRef.current && sameLayout(layoutRef.current, layout)) return;
      operationEpochRef.current += 1;
      layoutRef.current = layout;
      setLayoutState({ key: scopeKey, layout });
    });
  }, [scope, scopeKey]);

  useEffect(() => {
    if (!activeChatId || !workspaceLayout || visualChatFixture) return;
    if (
      accessibleChats !== undefined &&
      !accessibleChats.some((chat) => String(chat.id) === String(activeChatId))
    )
      return;
    const next = replacePrimaryChatPane(workspaceLayout, String(activeChatId));
    if (!sameLayout(workspaceLayout, next)) commitLayout(next);
  }, [accessibleChats, activeChatId, commitLayout, visualChatFixture, workspaceLayout]);

  useEffect(() => {
    if (!activeChatId || !workspaceLayout || accessibleChats === undefined || visualChatFixture)
      return;
    const accessibleIds = accessibleChats.map((chat) => String(chat.id));
    const activeIsAccessible = accessibleIds.includes(String(activeChatId));
    const reconcile = () => {
      const fallbackChatId = activeIsAccessible ? String(activeChatId) : accessibleIds[0];
      const pruned = pruneChatWorkspaceLayout(workspaceLayout, accessibleIds, fallbackChatId);
      const next =
        pruned ??
        (fallbackChatId
          ? ({
              version: 1,
              chatIds: [fallbackChatId],
              focusedChatId: fallbackChatId,
            } satisfies ChatWorkspaceLayoutV1)
          : null);
      if (!next) {
        if (scope) clearChatWorkspaceLayout(scope);
        operationEpochRef.current += 1;
        layoutRef.current = null;
        setLayoutState(null);
        setActiveChat(null);
        return;
      }
      if (!sameLayout(workspaceLayout, next)) commitLayout(next);
      if (!activeIsAccessible) setActiveChat(next.focusedChatId);
    };
    if (activeIsAccessible) {
      reconcile();
      return;
    }
    // A newly created chat can reach the selection store before the live list.
    // Verify its canonical row before treating that stale list as a deletion.
    let cancelled = false;
    void chatRepo.getById(activeChatId as ChatId).then(
      (chat) => {
        if (cancelled) return;
        if (
          chat && !chat.archived &&
          String(chat.workspace_id) === String(workspaceId) &&
          (chat.project_id ?? null) === (projectId ?? null)
        ) return;
        reconcile();
      },
      () => { if (!cancelled) reconcile(); },
    );
    return () => { cancelled = true; };
  }, [
    accessibleChats,
    activeChatId,
    commitLayout,
    scope,
    setActiveChat,
    visualChatFixture,
    workspaceLayout,
    workspaceId,
    projectId,
  ]);

  useEffect(() => {
    if (activeChatId || isVisualEmptyChat) return;
    let cancelled = false;
    setEnsuringChat(true);
    setEnsureFailed(false);
    void ensureActiveChat()
      .then((id) => {
        if (!cancelled && !id) setEnsureFailed(true);
      })
      .catch(() => {
        if (!cancelled) setEnsureFailed(true);
      })
      .finally(() => {
        if (!cancelled) setEnsuringChat(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChatId, isVisualEmptyChat]);

  const chatTitles = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const chat of accessibleChats ?? []) {
      titles[String(chat.id)] = chat.title?.trim() || 'Untitled chat';
    }
    if (visualChatFixture) titles[visualChatFixture.activeConversationId] = 'Fixture chat';
    return titles;
  }, [accessibleChats, visualChatFixture]);

  const openBeside = useCallback(
    async (payload: unknown, destinationChatId: string): Promise<ChatWorkspaceOpenResult> => {
      const current = layoutRef.current;
      const startScopeKey = activeScopeKeyRef.current;
      const startEpoch = operationEpochRef.current;
      if (!current || !startScopeKey) return { ok: false, reason: 'chat_unavailable' };
      const accepted = await resolveAcceptedChatDrop(
        { payload: payload as ChatDragPayloadV1, targetChatId: destinationChatId },
        {
          getChat: (id) => chatRepo.getById(id as ChatId),
          canAccess: (source, target) =>
            !source.archived &&
            !target.archived &&
            String(source.workspace_id) === String(workspaceId ?? '') &&
            String(source.project_id ?? '') === String(projectId ?? ''),
        },
      );
      let canonicalChat;
      if (!accepted.ok) {
        if (accepted.reason === 'same_chat') {
          const parsedPayload = payload as ChatDragPayloadV1;
          const target = await chatRepo.getById(destinationChatId as ChatId);
          if (
            !target ||
            target.archived ||
            String(target.workspace_id) !== String(workspaceId ?? '') ||
            String(target.project_id ?? '') !== String(projectId ?? '') ||
            String(target.workspace_id) !== parsedPayload.workspaceId ||
            (target.project_id ? String(target.project_id) : null) !== parsedPayload.projectId
          ) {
            return { ok: false, reason: 'chat_unavailable' };
          }
          canonicalChat = target;
        } else {
          return { ok: false, reason: accepted.reason };
        }
      } else {
        canonicalChat = accepted.chat;
      }
      if (
        activeScopeKeyRef.current !== startScopeKey ||
        operationEpochRef.current !== startEpoch ||
        layoutRef.current !== current
      ) {
        return {
          ok: false,
          reason: 'chat_unavailable',
        };
      }
      const canonicalId = String(canonicalChat.id);
      const source = {
        chatId: canonicalId,
        title: canonicalChat.title?.trim() || 'Untitled chat',
      };
      const action = current.chatIds.includes(canonicalId) ? 'focused_existing' : 'opened';
      const next =
        action === 'focused_existing'
          ? focusChatPane(current, canonicalId)
          : addChatPane(current, canonicalId);
      if ('ok' in next) return { ...next, source };
      // Validation resumes outside React's event batch. Publish layout and
      // navigation together at synchronous priority, so neither can reconcile
      // against the other's old value and overwrite the confirmed group/focus.
      let committed = false;
      flushSync(() => {
        committed = commitLayout(next);
        if (committed) setActiveChat(next.focusedChatId);
      });
      if (!committed) return { ok: false, reason: 'chat_unavailable' };
      return { ok: true, paneCount: next.chatIds.length, action, source };
    },
    [commitLayout, projectId, setActiveChat, workspaceId],
  );

  const effectiveLayout = visualChatFixture
    ? ({
        version: 1,
        chatIds: [visualChatFixture.activeConversationId],
        focusedChatId: visualChatFixture.activeConversationId,
      } satisfies ChatWorkspaceLayoutV1)
    : accessibleChats === undefined
      ? null
      : (() => {
          if (!workspaceLayout) return null;
          const accessibleIds = accessibleChats.map((chat) => String(chat.id));
          const fallbackChatId = accessibleIds.includes(String(activeChatId))
            ? String(activeChatId)
            : accessibleIds[0];
          return (
            pruneChatWorkspaceLayout(workspaceLayout, accessibleIds, fallbackChatId) ??
            (fallbackChatId
              ? ({
                  version: 1,
                  chatIds: [fallbackChatId],
                  focusedChatId: fallbackChatId,
                } satisfies ChatWorkspaceLayoutV1)
              : null)
          );
        })();
  const focusedChatId = isVisualEmptyChat ? undefined : effectiveLayout?.focusedChatId;
  const canonicalNativeDropChatId =
    !visualChatFixture &&
    focusedChatId &&
    accessibleChats?.some((chat) => String(chat.id) === focusedChatId)
      ? focusedChatId
      : undefined;
  const nativeDropAuthorityRef = useRef({
    scopeKey: null as string | null,
    chatId: null as string | null,
    epoch: 0,
  });
  const nativeDropScopeKey = canonicalNativeDropChatId && scopeKey ? scopeKey : null;
  if (
    nativeDropAuthorityRef.current.scopeKey !== nativeDropScopeKey ||
    nativeDropAuthorityRef.current.chatId !== (canonicalNativeDropChatId ?? null)
  ) {
    nativeDropAuthorityRef.current = {
      scopeKey: nativeDropScopeKey,
      chatId: canonicalNativeDropChatId ?? null,
      epoch: nativeDropAuthorityRef.current.epoch + 1,
    };
  }
  const nativeDropAuthorityEpoch = nativeDropAuthorityRef.current.epoch;

  useEffect(() => {
    if (!isTauri || !canonicalNativeDropChatId || !scopeKey) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const listenerScopeKey = scopeKey;
    const listenerEpoch = nativeDropAuthorityEpoch;
    const isCurrentListener = () =>
      !disposed &&
      activeScopeKeyRef.current === listenerScopeKey &&
      nativeDropAuthorityRef.current.scopeKey === listenerScopeKey &&
      nativeDropAuthorityRef.current.chatId === canonicalNativeDropChatId &&
      nativeDropAuthorityRef.current.epoch === listenerEpoch;
    const handleNativeDrop = createNativeChatFileDropHandler({
      devicePixelRatio: window.devicePixelRatio,
      hitTest: (clientX, clientY) => {
        if (!isCurrentListener()) return false;
        const dropRoot = document
          .elementFromPoint(clientX, clientY)
          ?.closest('[data-vibespace-page="chat"][data-terminal-drop="chat"]');
        return dropRoot?.getAttribute('data-terminal-drop-chat-id') === canonicalNativeDropChatId;
      },
      onHoverChange: (hovering) => setDropKind(hovering ? 'os-files' : null),
      onDropPaths: (paths) => {
        if (!isCurrentListener()) return;
        for (const path of paths) {
          window.dispatchEvent(
            new CustomEvent('jarvis:file:attach', {
              detail: { path, chatId: canonicalNativeDropChatId },
            }),
          );
        }
      },
    });

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (isCurrentListener()) handleNativeDrop(event.payload);
        }),
      )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {
        // Browser preview and unavailable native bridges keep the existing DOM drop path.
      });
    return () => {
      disposed = true;
      setDropKind(null);
      unlisten?.();
    };
  }, [canonicalNativeDropChatId, nativeDropAuthorityEpoch, scopeKey]);

  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-vibespace-page="chat"
        data-token-boss-host="true"
        data-monochrome-surface="chat"
        data-sakura-surface="chat-route"
        data-terminal-drop={focusedChatId ? 'chat' : undefined}
        data-terminal-drop-chat-id={focusedChatId}
        onDragOver={(event) => {
          if (!focusedChatId) return;
          const nextKind = getChatDragKind(event.dataTransfer.types);
          if (!nextKind) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = nextKind === 'os-files' ? 'copy' : 'link';
          setDropKind(nextKind);
        }}
        onDragLeave={() => setDropKind(null)}
        onDrop={(event) => {
          if (!focusedChatId) return;
          const osFiles = event.dataTransfer.files;
          if (osFiles && osFiles.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            setDropKind(null);
            dispatchMediaAttach(String(focusedChatId), osFiles);
            return;
          }
          const payload = getChatDropPayload(event.dataTransfer);
          if (!payload) return;
          event.preventDefault();
          event.stopPropagation();
          setDropKind(null);
          if (payload.kind === 'context') {
            window.dispatchEvent(
              new CustomEvent('jarvis:context:attach', {
                detail: { raw: payload.raw, chatId: focusedChatId },
              }),
            );
          } else if (payload.kind === 'terminal') {
            window.dispatchEvent(
              new CustomEvent('jarvis:terminal:attach', {
                detail: { raw: payload.raw, chatId: focusedChatId },
              }),
            );
          } else {
            window.dispatchEvent(
              new CustomEvent('jarvis:file:attach', {
                detail: { path: payload.path, chatId: focusedChatId },
              }),
            );
          }
        }}
        className={cn(
          'relative flex h-full w-full flex-col bg-background transition-shadow',
          '[[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none [[data-theme=monochrome]_&]:transition-none',
          dropKind && 'ring-inset ring-2 ring-accent-copper/50',
        )}
      >
        <OrigamiChatDecor />
        <VibeCheckPanel />
        {dropKind ? (
          <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-md border border-accent-copper/50 bg-background/95 px-3 py-1 text-metadata text-accent-copper shadow-soft [[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border-mid [[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none">
            Drop{' '}
            {dropKind === 'context'
              ? 'Context'
              : dropKind === 'terminal'
                ? 'terminal'
                : dropKind === 'os-files'
                  ? 'photos, videos, or files'
                  : 'file path'}{' '}
            here to power up this chat
          </div>
        ) : null}
        {isVisualEmptyChat ? (
          <EmptyChat />
        ) : visualChatFixture ? (
          <VisualFixtureChatSurface
            activeChatId={visualChatFixture.activeConversationId}
            messages={visualChatFixture.messages}
          />
        ) : activeChatId && effectiveLayout ? (
          <ChatWorkspace
            layout={effectiveLayout}
            chatTitles={chatTitles}
            onFocus={(chatId) => {
              const current = layoutRef.current;
              if (!current) return;
              const next = focusChatPane(current, chatId);
              commitLayout(next);
              setActiveChat(chatId);
            }}
            onClose={(chatId) => {
              const current = layoutRef.current;
              if (!current) return;
              const next = closeChatPane(current, chatId);
              if (sameLayout(current, next)) return;
              commitLayout(next);
              setActiveChat(next.focusedChatId);
            }}
            onOpenBeside={openBeside}
          />
        ) : ensuringChat ? (
          <div className="flex flex-1 items-center justify-center text-secondary text-muted-foreground">
            Starting a conversation…
          </div>
        ) : (
          <EmptyChat />
        )}
        {!isVisualEmptyChat && ensureFailed && !activeChatId && !ensuringChat ? (
          <p className="px-4 pb-3 text-center text-metadata text-muted-foreground">
            Could not open a chat yet — workspace may still be loading.
          </p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
