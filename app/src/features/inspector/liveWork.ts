import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useUIStore } from '@/stores/ui';
import type { LiveChatStatus, LiveTerminalStatus, LiveWorkStatus } from './types';
import type { WorkspaceId } from '@/types/common';
import type { TerminalSession } from '@/types/terminal';
import type { Chat } from '@/types/chat';

function isAgentBusy(state: string | undefined): boolean {
  return state === 'streaming' || state === 'thinking' || state === 'tool_calling' || state === 'reading' || state === 'queued';
}

export const STATIONARY_AFTER_MS = 4_000;

export function getTerminalWorkStatus(lastOutputAt?: number, hasActiveProcess = true): LiveWorkStatus {
  if (hasActiveProcess && lastOutputAt && Date.now() - lastOutputAt < STATIONARY_AFTER_MS) {
    return 'working';
  }
  if (!lastOutputAt) return 'stationary';
  return Date.now() - lastOutputAt < STATIONARY_AFTER_MS ? 'working' : 'stationary';
}

export function useLiveTerminalStatuses(workspaceId: WorkspaceId | null, projectId: string | null): LiveTerminalStatus[] {
  const transcripts = useTerminalTranscriptStore((s) => s.sessions);

  const sessions =
    useLiveQuery(async () => {
      if (!workspaceId) return [] as TerminalSession[];
      const rows = await db.terminal_sessions.where('workspace_id').equals(workspaceId).toArray();
      return rows
        .filter((s) => {
          const sameProject = projectId ? s.project_id === projectId : !s.project_id;
          return sameProject && s.status !== 'exited';
        })
        .sort((a, b) => b.last_active_at - a.last_active_at);
    }, [workspaceId, projectId]) ?? [];

  return useMemo(() => {
    return sessions.map((session) => {
      const transcript = transcripts[session.id];
      const lastOutputAt = transcript?.lastWriteAt ?? session.last_active_at;
      const status = getTerminalWorkStatus(lastOutputAt, session.status === 'running');
      const summary = transcript?.text?.trim().split('\n').filter(Boolean).pop()?.slice(0, 120);
      return {
        terminalId: session.id,
        sessionId: session.id,
        terminalName: session.title?.trim() || `Terminal ${session.id.slice(0, 6)}`,
        agentName: transcript?.agentSlug ?? undefined,
        status,
        lastOutputAt,
        lastActivitySummary: summary,
      };
    });
  }, [sessions, transcripts]);
}

export function useLiveChatStatuses(workspaceId: WorkspaceId | null, projectId: string | null): LiveChatStatus[] {
  const runStates = useAgentStore((s) => s.runStates);
  const chats =
    useLiveQuery(async () => {
      if (!workspaceId) return [] as Chat[];
      const rows = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      return rows
        .filter((c) => (projectId ? c.project_id === projectId : !c.project_id))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 16);
    }, [workspaceId, projectId]) ?? [];

  return useMemo(() => {
    const anyStreaming = Object.values(runStates).some((st) => isAgentBusy(st));
    return chats.map((chat) => {
      const recent = Date.now() - chat.updated_at < STATIONARY_AFTER_MS;
      const status: LiveWorkStatus = anyStreaming && recent ? 'working' : 'stationary';
      return {
        chatId: chat.id,
        title: chat.title?.trim() || 'Untitled chat',
        status,
        lastActivityAt: chat.updated_at,
        lastMessagePreview: undefined,
      };
    });
  }, [chats, runStates]);
}

export function focusTerminalSession(sessionId: string, paneId?: string): void {
  useUIStore.getState().setRoute('terminal');
  window.dispatchEvent(
    new CustomEvent('jarvis:terminal:focus', { detail: { sessionId, paneId } }),
  );
}

export function focusChat(chatId: string): void {
  const ui = useUIStore.getState();
  ui.setRoute('chat');
  ui.setActiveChat(chatId);
  window.dispatchEvent(new CustomEvent('jarvis:chat:focus', { detail: { chatId } }));
}
