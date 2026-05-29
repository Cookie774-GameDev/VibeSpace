import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { taskRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/stores/auth';
import type { Task } from '@/types/task';
import type { WorkspaceId } from '@/types/common';

/**
 * Live tasks for a workspace - watches the underlying dexie tables and
 * re-renders when anything changes (create, update, delete, reminder shift).
 */
export function useTasks(workspaceId: WorkspaceId | null): Task[] {
  const data = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Task[];
      return taskRepo.listOpen(workspaceId);
    },
    [workspaceId],
    [] as Task[],
  );
  return data ?? [];
}

/**
 * Tasks due (or scheduled) within today.  Pulls from `useTasks`
 * to avoid a second live query.
 */
export function useTodayTasks(): Task[] {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const all = useTasks(workspaceId);
  return useMemo(() => {
    const todayEnd = endOfTodayMs();
    return all.filter((t) => {
      if (t.status !== 'open' && t.status !== 'in_progress') return false;
      const ts = t.due_at ?? t.scheduled_for;
      if (ts === undefined) return false;
      return ts <= todayEnd;
    });
  }, [all]);
}

/**
 * Tasks within the next 7 days (incl. today).
 */
export function useUpcomingTasks(): Task[] {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const all = useTasks(workspaceId);
  return useMemo(() => {
    const limit = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return all.filter((t) => {
      if (t.status !== 'open' && t.status !== 'in_progress') return false;
      const ts = t.due_at ?? t.scheduled_for;
      if (ts === undefined) return false;
      return ts <= limit;
    });
  }, [all]);
}

/**
 * Done tasks completed in the last 24h.  Used by the "Done" section
 * (collapsed by default) in the to-do panel.
 */
export function useRecentlyCompletedTasks(): Task[] {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  const data = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Task[];
      const all = await taskRepo.listByStatus(workspaceId, 'done');
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return all.filter((t) => (t.done_at ?? 0) >= cutoff);
    },
    [workspaceId],
    [] as Task[],
  );
  return data ?? [];
}

// ============================================================
// Helpers
// ============================================================

function endOfTodayMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
