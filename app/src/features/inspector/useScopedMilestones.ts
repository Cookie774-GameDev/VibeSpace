import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import Dexie, { type ObservabilitySet } from 'dexie';
import { db } from '@/lib/db/database';
import { projectRepo, workspaceRepo } from '@/lib/db/repositories';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { useMilestonesStore } from './milestonesStore';
import { createScopedMilestonePort, type MilestoneOwnerScope } from './milestoneScope';
import type { MilestoneKind } from './types';

type MilestoneAdmission = { key: string; epoch: number; revision: number; sequence: number; allowed: boolean };

export function isMilestoneOwnerMutation(parts: ObservabilitySet, databaseName: string): boolean {
  const prefix = `idb://${databaseName}/`;
  return Object.keys(parts).some((part) => part.startsWith(`${prefix}workspaces/`) ||
    part.startsWith(`${prefix}projects/`));
}

export const milestoneOwnerScopeKey = (scope: MilestoneOwnerScope | null) => JSON.stringify(scope ?
  [scope.accountId, scope.workspaceId, scope.projectId] : null);

export async function verifyMilestoneOwnerScope(scope: MilestoneOwnerScope | null): Promise<boolean> {
  if (!scope || !scope.accountId || !scope.workspaceId || !scope.projectId) return false;
  try {
    const [workspace, project] = await Promise.all([
      workspaceRepo.getById(scope.workspaceId as WorkspaceId),
      projectRepo.getById(scope.projectId as ProjectId),
    ]);
    return workspace?.id === scope.workspaceId && workspace.owner_id === scope.accountId &&
      project?.id === scope.projectId && project.workspace_id === scope.workspaceId;
  } catch {
    return false;
  }
}

function scopeFromAuth(auth: ReturnType<typeof useAuthStore.getState>): MilestoneOwnerScope | null {
  const accountId = resolveAccountIdentity(auth)?.accountId;
  return accountId && auth.workspaceId && auth.projectId ?
    { accountId, workspaceId: String(auth.workspaceId), projectId: String(auth.projectId) } : null;
}

export function currentMilestoneOwnerScope(): MilestoneOwnerScope | null {
  return scopeFromAuth(useAuthStore.getState());
}

/** Short-lived read lease for async aggregate work; a witnessed A -> B -> A stays stale. */
export function captureMilestoneScopeRead() {
  const scope = currentMilestoneOwnerScope();
  const key = milestoneOwnerScopeKey(scope);
  let changed = false;
  const dispose = useAuthStore.subscribe((next) => {
    if (milestoneOwnerScopeKey(scopeFromAuth(next)) !== key) changed = true;
  });
  return { scope, key, dispose, isCurrent: () => !changed && milestoneOwnerScopeKey(currentMilestoneOwnerScope()) === key };
}

/** All ordinary milestone views use the same owner-joined, live scoped port.
 * Scope transitions increment an epoch: an old A callback cannot act after A -> B -> A.
 * Persistence remains intact; unowned legacy rows are never guessed into the active account.
 */
export function useScopedMilestones() {
  const accountId = useAuthStore((auth) => resolveAccountIdentity(auth)?.accountId ?? '');
  const workspaceId = useAuthStore((auth) => auth.workspaceId);
  const projectId = useAuthStore((auth) => auth.projectId);
  const scope = useMemo(() => accountId && workspaceId && projectId ?
    { accountId, workspaceId: String(workspaceId), projectId: String(projectId) } : null,
  [accountId, workspaceId, projectId]);
  const key = milestoneOwnerScopeKey(scope);
  const generation = useRef({ key, epoch: 1 });
  const verification = useRef<{ revision: number; sequence: number; pending: boolean;
    result: MilestoneAdmission | null }>({ revision: 0, sequence: 0, pending: true, result: null });
  const [admission, setAdmission] = useState<MilestoneAdmission | null>(null);
  useEffect(() => {
    let mounted = true;
    const databaseName = db.name;
    const rejoin = (nextScope: MilestoneOwnerScope | null) => {
      const nextKey = milestoneOwnerScopeKey(nextScope);
      if (nextKey !== generation.current.key)
        generation.current = { key: nextKey, epoch: generation.current.epoch + 1 };
      const { epoch } = generation.current;
      const revision = verification.current.revision;
      const sequence = ++verification.current.sequence;
      verification.current.pending = true;
      verification.current.result = null;
      setAdmission(null);
      // Subscription events start the exact joined read directly, including batched A -> B -> A.
      // Re-admission does not depend on an observable rerunning after an identical auth snapshot.
      void verifyMilestoneOwnerScope(nextScope).then((allowed) => {
        if (!mounted || verification.current.revision !== revision ||
          verification.current.sequence !== sequence || generation.current.epoch !== epoch ||
          milestoneOwnerScopeKey(currentMilestoneOwnerScope()) !== nextKey) return;
        const result = { key: nextKey, epoch, revision, sequence, allowed };
        verification.current.pending = false;
        verification.current.result = result;
        setAdmission(result);
      });
    };
    const invalidate = (parts: ObservabilitySet) => {
      if (!isMilestoneOwnerMutation(parts, databaseName)) return;
      // Revoke synchronous mutation authority before the deferred ownership read can finish.
      verification.current.revision += 1;
      rejoin(currentMilestoneOwnerScope());
    };
    Dexie.on.storagemutated.subscribe(invalidate);
    const unsubscribeAuth = useAuthStore.subscribe((next) => {
      const nextScope = scopeFromAuth(next);
      if (milestoneOwnerScopeKey(nextScope) !== generation.current.key) rejoin(nextScope);
    });
    rejoin(currentMilestoneOwnerScope());
    return () => {
      mounted = false;
      verification.current.sequence += 1;
      verification.current.pending = true;
      verification.current.result = null;
      Dexie.on.storagemutated.unsubscribe(invalidate);
      unsubscribeAuth();
    };
  }, []);
  const epoch = generation.current.epoch;
  const revision = verification.current.revision;
  const storedItems = useMilestonesStore((state) => state.items);
  const port = useMemo(() => createScopedMilestonePort(useMilestonesStore, scope, () =>
    generation.current.epoch === epoch && milestoneOwnerScopeKey(currentMilestoneOwnerScope()) === key &&
    !verification.current.pending && verification.current.result?.key === key &&
    verification.current.result.epoch === epoch && verification.current.result.revision === verification.current.revision &&
    verification.current.result.sequence === verification.current.sequence &&
    verification.current.result.allowed === true), [scope, key, epoch]);
  const ready = !verification.current.pending && admission === verification.current.result &&
    admission?.key === key && admission.epoch === epoch && admission.revision === revision &&
    admission.sequence === verification.current.sequence && admission.allowed === true;
  const items = useMemo(() => port.list(), [port, storedItems, admission, ready]);
  return {
    scopeKey: key,
    scope: ready ? scope : null,
    ready,
    items,
    completedMilestones: items.filter((item) => item.status === 'done').length,
    addMilestone(title: string, kind: MilestoneKind = 'todo', description?: string, deadlineAt?: number) {
      if (!ready) return null;
      try { return port.add(title, kind, `ui:${crypto.randomUUID()}`, description, deadlineAt); }
      catch { return null; }
    },
    updateMilestone: port.update,
    removeMilestone: port.remove,
    toggleDone: port.toggle,
    clearCompletedTodos: port.clearCompletedTodos,
  };
}

/** Retain drafts by owner tuple without showing an A draft in B's project/account. */
export function useScopedMilestoneDraft(scopeKey: string) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = useCallback((change: SetStateAction<string>) => {
    setDrafts((current) => ({ ...current, [scopeKey]: typeof change === 'function' ?
      change(current[scopeKey] ?? '') : change }));
  }, [scopeKey]);
  return [drafts[scopeKey] ?? '', setDraft] as const;
}
