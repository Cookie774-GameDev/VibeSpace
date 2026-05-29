import { useLiveQuery } from 'dexie-react-hooks';
import { taskRepo, projectRepo } from '@/lib/db/repositories';
import type { Task } from '@/types/task';
import type { WorkspaceId } from '@/types/common';
import type { Project } from '@/lib/db/schema';

/**
 * Live tasks for a workspace, filtered by an in-memory project filter.
 *
 * `projectFilter` is either the string 'all' or a `ProjectId`. We list every
 * task in the workspace once, then filter in memory so the user can flip the
 * dropdown without retriggering a Dexie round-trip.
 */
export function useKanbanTasks(
  workspaceId: WorkspaceId | null,
  projectFilter: string,
): Task[] {
  const tasks = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Task[];
      return taskRepo.listByWorkspace(workspaceId);
    },
    [workspaceId, projectFilter],
    [] as Task[],
  );
  return (tasks ?? []).filter(
    (t) => projectFilter === 'all' || t.project_id === projectFilter,
  );
}

/**
 * Live projects for the workspace, used to populate the filter dropdown
 * and resolve project chips on each card.
 */
export function useKanbanProjects(workspaceId: WorkspaceId | null): Project[] {
  const projects = useLiveQuery(
    async () => {
      if (!workspaceId) return [] as Project[];
      return projectRepo.listByWorkspace(workspaceId);
    },
    [workspaceId],
    [] as Project[],
  );
  return projects ?? [];
}
