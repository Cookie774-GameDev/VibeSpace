/**
 * Seed the local Dexie database with a default workspace, project and the
 * built-in agent roster on first launch. Idempotent: if any workspace
 * already exists, this is a no-op.
 *
 * The seeded local user id (`usr_*`) is generated with nanoid and persists
 * across launches via the auth store. It's used as `owner_id` on local rows
 * so RLS-equivalent filters work even before cloud sync is wired up.
 */

import { nanoid } from 'nanoid';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { newProjectId, newWorkspaceId } from '@/lib/ids';
import { createBuiltinAgentRoster } from '@/lib/jarvis/builtinAgents';
import { useAuthStore } from '@/stores/auth';
import { db, openDb } from './database';

/**
 * Result returned by `seedIfEmpty`.
 */
export type SeedResult = {
  /** True if seeding actually ran on this call. */
  seeded: boolean;
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  /** The local user id used as owner of seeded rows. */
  user_id?: string;
};

async function restoreAuthFromExistingWorkspace(force = false): Promise<void> {
  const auth = useAuthStore.getState();
  if (auth.workspaceId && auth.localUserId && !force) return;
  if (auth.workspaceId && !force) {
    const activeWorkspace = await db.workspaces.get(auth.workspaceId);
    if (activeWorkspace) auth.setLocalUser(activeWorkspace.owner_id);
    return;
  }
  const workspace = await db.workspaces.toCollection().first();
  if (!workspace) return;
  auth.setWorkspaceId(workspace.id);
  const project = await db.projects.where('workspace_id').equals(workspace.id).first();
  if (project) auth.setProjectId(project.id);
  if (force || !auth.localUserId) auth.setLocalUser(workspace.owner_id);
}

/**
 * Run the first-launch seed. Idempotent and safe to call multiple times.
 *
 * On a fresh database this creates:
 *   - 1 workspace named "Personal" (owner_id = a generated `usr_*` id).
 *   - 1 project named "Inbox" inside that workspace.
 *   - The canonical built-in Jarvis and Coder agents.
 *
 * It also primes `useAuthStore` with the active workspace and project so
 * the rest of the app boots into a usable state.
 */
export async function seedIfEmpty(): Promise<SeedResult> {
  await openDb();

  const persistedAuth = useAuthStore.getState();
  if (persistedAuth.localUserId && persistedAuth.workspaceId && persistedAuth.projectId) {
    // A complete persisted scope may belong to a project that is restored by
    // cloud/local reconciliation after bootstrap. Allocating a fresh Inbox in
    // this window would replace that authority and hide its surviving chats,
    // maps, and jobs. Only a genuine first launch with no complete scope may
    // claim new active workspace/project IDs below.
    if (!persistedAuth.cloudSession) {
      const activeWorkspace = await db.workspaces.get(persistedAuth.workspaceId);
      if (activeWorkspace && activeWorkspace.owner_id !== persistedAuth.localUserId) {
        useAuthStore.getState().setLocalUser(activeWorkspace.owner_id);
      }
    }
    return { seeded: false };
  }

  const existing = await db.workspaces.count();
  if (existing > 0) {
    // Already seeded. Make sure the auth store has an active workspace though,
    // otherwise consumers will see null workspaceId on a re-install where the
    // localStorage was cleared but the IndexedDB persisted.
    await restoreAuthFromExistingWorkspace();
    return { seeded: false };
  }

  const result = await db.transaction('rw', db.workspaces, db.projects, db.agents, async () => {
    // The pre-transaction check is only a fast path. A concurrent bootstrap may
    // win while this caller waits for the write transaction, so recheck under
    // the transaction lock before allocating any durable rows.
    if ((await db.workspaces.count()) > 0) return { seeded: false as const };

    const ts = Date.now();
    const userId = useAuthStore.getState().localUserId ?? `usr_${nanoid(16)}`;
    const workspaceId = newWorkspaceId();
    const projectId = newProjectId();

    await db.workspaces.add({
      id: workspaceId,
      name: 'Personal',
      owner_id: userId,
      created_at: ts,
      updated_at: ts,
    });

    await db.projects.add({
      id: projectId,
      workspace_id: workspaceId,
      name: 'Inbox',
      color_hue: 210,
      created_at: ts,
      updated_at: ts,
    });

    await db.agents.bulkAdd(createBuiltinAgentRoster({ now: ts }));
    return { seeded: true as const, userId, workspaceId, projectId };
  });

  if (!result.seeded) {
    await restoreAuthFromExistingWorkspace(true);
    return { seeded: false };
  }

  const { userId, workspaceId, projectId } = result;

  // Prime the auth store so the UI has an active context.
  const auth = useAuthStore.getState();
  if (!auth.localUserId) auth.setLocalUser(userId);
  auth.setWorkspaceId(workspaceId);
  auth.setProjectId(projectId);

  return { seeded: true, workspace_id: workspaceId, project_id: projectId, user_id: userId };
}
