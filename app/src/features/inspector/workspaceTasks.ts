import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, taskRepo } from '@/lib/db';
import { useAgentStore } from '@/stores/agents';
import { useToolRunsStore } from './toolRunsStore';
import { useMilestonesStore } from './milestonesStore';
import type { VibeSpaceTask, VibeSpaceTaskStatus } from './types';
import type { WorkspaceId } from '@/types/common';
import type { TerminalSession } from '@/types/terminal';

function isAgentBusy(state: string | undefined): boolean {
  return state === 'streaming' || state === 'thinking' || state === 'tool_calling' || state === 'reading' || state === 'queued';
}

export function useWorkspaceOpenTasks(workspaceId: WorkspaceId | null, projectId: string | null): VibeSpaceTask[] {
  const kanbanTasks =
    useLiveQuery(async () => {
      if (!workspaceId) return [];
      return taskRepo.listOpen(workspaceId);
    }, [workspaceId]) ?? [];

  const terminalSessions =
    useLiveQuery(async () => {
      if (!workspaceId) return [] as TerminalSession[];
      const rows = await db.terminal_sessions.where('workspace_id').equals(workspaceId).toArray();
      return rows.filter((s) => {
        const sameProject = projectId ? s.project_id === projectId : !s.project_id;
        return sameProject && s.status === 'running';
      });
    }, [workspaceId, projectId]) ?? [];

  const activeChats =
    useLiveQuery(async () => {
      if (!workspaceId) return [];
      const chats = await db.chats.where('workspace_id').equals(workspaceId).toArray();
      return chats
        .filter((c) => (projectId ? c.project_id === projectId : !c.project_id))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 12);
    }, [workspaceId, projectId]) ?? [];

  const runStates = useAgentStore((s) => s.runStates);
  const allToolRuns = useToolRunsStore((s) => s.runs);
  const allMilestones = useMilestonesStore((s) => s.items);
  const toolRuns = useMemo(
    () => allToolRuns.filter((r) => r.status === 'running'),
    [allToolRuns],
  );
  const milestones = useMemo(
    () => allMilestones.filter((i) => i.status !== 'done'),
    [allMilestones],
  );

  return useMemo(() => {
    const now = Date.now();
    const out: VibeSpaceTask[] = [];

    for (const t of kanbanTasks) {
      const status: VibeSpaceTaskStatus =
        t.status === 'in_progress' ? 'working' : t.status === 'blocked' ? 'blocked' : 'open';
      out.push({
        id: `kanban:${t.id}`,
        title: t.title,
        source: 'kanban',
        status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        completedAt: t.done_at,
      });
    }

    for (const session of terminalSessions) {
      out.push({
        id: `terminal:${session.id}`,
        title: session.title?.trim() || `Terminal ${session.id.slice(0, 6)}`,
        source: 'terminal',
        status: 'working',
        createdAt: session.created_at,
        updatedAt: session.last_active_at,
        relatedTerminalId: session.id,
      });
    }

    for (const chat of activeChats) {
      const streaming = Object.values(runStates).some((st) => isAgentBusy(st));
      if (!streaming && now - chat.updated_at > 120_000) continue;
      out.push({
        id: `chat:${chat.id}`,
        title: chat.title?.trim() || 'Chat',
        source: 'chat',
        status: streaming ? 'working' : 'open',
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
        relatedChatId: chat.id,
      });
    }

    for (const run of toolRuns) {
      out.push({
        id: `tool:${run.id}`,
        title: `Running ${run.toolName}`,
        source: 'tool',
        status: 'working',
        createdAt: run.startedAt,
        updatedAt: run.startedAt,
        relatedToolId: run.toolId,
      });
    }

    for (const ms of milestones) {
      out.push({
        id: `milestone:${ms.id}`,
        title: ms.title,
        source: 'milestone',
        status: ms.status === 'working' ? 'working' : 'open',
        createdAt: ms.createdAt,
        updatedAt: ms.updatedAt,
      });
    }

    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }, [kanbanTasks, terminalSessions, activeChats, runStates, toolRuns, milestones]);
}

export function openTaskCount(tasks: VibeSpaceTask[]): number {
  return tasks.filter((t) => t.status === 'open' || t.status === 'working' || t.status === 'blocked').length;
}
