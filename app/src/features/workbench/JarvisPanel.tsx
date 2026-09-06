import * as React from 'react';
import { Plus } from 'lucide-react';
import { ThemedSelect } from '@/components/ui/themed-select';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChatThread, Composer, EmptyChat, ensureActiveChat } from '@/features/chat';
import { TokenBossCinematic } from '@/features/chat/token-boss/TokenBossCinematic';
import { toast } from '@/components/ui/toast';
import { db } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { WorkspaceId } from '@/types';
import type { WorkbenchPanel } from './types';
import { useStorageDoctorSnapshot } from '@/features/doctor/StorageDoctorNotice';
import { isStorageDoctorUnavailableError } from '@/lib/doctor/storageDoctor';

interface JarvisPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

/**
 * Real VibeSpace chat surface inside Workbench with chat picker + new-chat control.
 */
export function JarvisPanel({ panel, onUpdate }: JarvisPanelProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(panel.width);
  React.useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const compact = width < 640;
  const chatScale = Math.max(0.72, Math.min(1, width / 560));
  const storageHealth = useStorageDoctorSnapshot();
  const chatCreationBlocked = storageHealth.kind !== 'healthy';
  const activeChatId = useUIStore((state) => state.activeChatId);
  const setActiveChat = useUIStore((state) => state.setActiveChat);
  const workspaceId = useAuthStore((state) => state.workspaceId) as WorkspaceId | null;
  const projectId = useAuthStore((state) => state.projectId);
  const [ensuring, setEnsuring] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const onUpdateRef = React.useRef(onUpdate);
  const statusRef = React.useRef(panel.status);
  onUpdateRef.current = onUpdate;
  statusRef.current = panel.status;

  const queriedChats = useLiveQuery(async () => {
    if (!workspaceId) return [];
    const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
    const filtered = projectId
      ? rows.filter((chat) => chat.project_id === projectId)
      : rows.filter((chat) => !chat.project_id);
    return filtered.sort((a, b) => b.updated_at - a.updated_at).slice(0, 80);
  }, [workspaceId, projectId]);
  const chats = React.useMemo(
    () =>
      (queriedChats ?? [])
        .filter(
          (chat) =>
            String(chat.workspace_id) === String(workspaceId ?? '') &&
            String(chat.project_id ?? '') === String(projectId ?? ''),
        )
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 80),
    [projectId, queriedChats, workspaceId],
  );
  const chatsHydrated = queriedChats !== undefined;
  const activeChatIsAccessible = Boolean(
    activeChatId && chats.some((chat) => String(chat.id) === String(activeChatId)),
  );

  const setStatusIfChanged = React.useCallback((status: WorkbenchPanel['status']) => {
    if (statusRef.current === status) return;
    statusRef.current = status;
    onUpdateRef.current({ status });
  }, []);

  React.useEffect(() => {
    if (!workspaceId) {
      setEnsuring(false);
      setFailed(true);
      setStatusIfChanged('attention');
      return;
    }
    if (!chatsHydrated) {
      setEnsuring(true);
      setFailed(false);
      return;
    }
    if (activeChatIsAccessible) {
      setEnsuring(false);
      setFailed(false);
      setStatusIfChanged('ready');
      return;
    }
    let cancelled = false;
    setEnsuring(true);
    setFailed(false);
    void ensureActiveChat({ navigateToChat: false })
      .then((id) => {
        if (cancelled) return;
        if (!id) {
          setFailed(true);
          setStatusIfChanged('attention');
        } else {
          setStatusIfChanged('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setStatusIfChanged('error');
        }
      })
      .finally(() => {
        if (!cancelled) setEnsuring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeChatId,
    activeChatIsAccessible,
    chatsHydrated,
    projectId,
    setStatusIfChanged,
    workspaceId,
  ]);

  const createNewChat = React.useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setFailed(false);
    try {
      // Same path as the rest of the app (Ctrl+N / EmptyChat / jarvis:new-chat).
      const chatId = await ensureActiveChat({ forceNew: true, navigateToChat: false });
      if (!chatId) {
        toast.warning('Still loading', 'Workspace is initializing — try again in a moment.');
        setFailed(true);
        setStatusIfChanged('attention');
        return;
      }
      setActiveChat(chatId);
      setStatusIfChanged('ready');
      toast.success('New chat', 'Ready in Workbench Jarvis');
    } catch (err) {
      if (!isStorageDoctorUnavailableError(err)) {
        toast.error('Could not create chat', err instanceof Error ? err.message : 'Try again.');
      }
      setFailed(true);
      setStatusIfChanged('error');
    } finally {
      setCreating(false);
    }
  }, [creating, setActiveChat, setStatusIfChanged]);

  return (
    <div
      className="workbench-jarvis"
      ref={panelRef}
      data-testid="workbench-jarvis-panel"
      data-panel-id={panel.id}
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="workbench-jarvis-toolbar">
        <label htmlFor={`workbench-chat-select-${panel.id}`}>Chat</label>
        <ThemedSelect
          id={`workbench-chat-select-${panel.id}`}
          label="Select chat"
          value={activeChatIsAccessible ? (activeChatId ?? '') : ''}
          onChange={(next) => {
            if (next) setActiveChat(next);
          }}
          options={chats.map((chat) => ({
            value: String(chat.id),
            label: chat.title?.trim() || 'Untitled chat',
          }))}
        />
        <button
          type="button"
          className="workbench-jarvis-new-chat"
          aria-label="New chat"
          title="New chat"
          disabled={creating || !workspaceId || chatCreationBlocked}
          aria-describedby={chatCreationBlocked ? 'vibespace-storage-doctor-status' : undefined}
          onClick={() => void createNewChat()}
        >
          <Plus aria-hidden="true" strokeWidth={2.25} />
        </button>
      </div>
      {activeChatId && activeChatIsAccessible ? (
        <div
          className="workbench-jarvis-body relative min-h-0"
          data-token-boss-host="true"
          style={{ zoom: chatScale }}
        >
          <ChatThread chatId={activeChatId} compact={compact} />
          <Composer chatId={activeChatId} compact={compact} disableRouteSlashCommands />
          <TokenBossCinematic chatId={String(activeChatId)} compact={compact} />
        </div>
      ) : ensuring || creating ? (
        <div className="workbench-panel-empty">
          <strong>{creating ? 'Creating chat…' : 'Starting Jarvis…'}</strong>
          <span>Opening the shared conversation for this workspace.</span>
        </div>
      ) : failed ? (
        <div className="workbench-panel-empty" role="alert">
          <strong>Chat unavailable</strong>
          <span>Could not open a chat — use the + button to try again.</span>
          <button
            type="button"
            className="workbench-jarvis-new-chat workbench-jarvis-new-chat--lg"
            aria-label="New chat"
            disabled={chatCreationBlocked}
            aria-describedby={chatCreationBlocked ? 'vibespace-storage-doctor-status' : undefined}
            onClick={() => void createNewChat()}
          >
            <Plus aria-hidden="true" strokeWidth={2.25} />
            <span>New chat</span>
          </button>
        </div>
      ) : (
        <EmptyChat onNewChat={() => void createNewChat()} />
      )}
    </div>
  );
}
