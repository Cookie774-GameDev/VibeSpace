import type { MilestoneItem, MilestoneKind, MilestoneScope } from '@/features/inspector/types';

export type MilestoneOwnerScope = Readonly<Pick<MilestoneScope, 'accountId' | 'workspaceId' | 'projectId'>>;

function validScope(scope: MilestoneOwnerScope | null): scope is MilestoneOwnerScope {
  return Boolean(scope && [scope.accountId, scope.workspaceId, scope.projectId]
    .every((id) => typeof id === 'string' && id.trim().length > 0 && id === id.trim()));
}

export function milestoneBelongsToScope(item: MilestoneItem, scope: MilestoneOwnerScope | null): boolean {
  return validScope(scope) && validScope(item.scope ?? null) &&
    item.scope?.accountId === scope.accountId &&
    item.scope.workspaceId === scope.workspaceId &&
    item.scope.projectId === scope.projectId;
}

type MilestoneStorePort = {
  getState(): {
    items: MilestoneItem[];
    addMilestone(title: string, kind?: MilestoneKind, description?: string,
      deadlineAt?: number, scope?: MilestoneScope): string;
    updateMilestone(id: string, patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status' | 'deadlineAt'>>): void;
    removeMilestone(id: string): void;
    toggleDone(id: string): void;
  };
};

/** UI adapter: legacy rows are retained without automatic ownership assignment.
 * Unknown-scope rows are quarantined from all scoped UI and mutations.
 * requestId remains per creation and does not restrict visibility to a single command request.
 */
export function createScopedMilestonePort(
  store: MilestoneStorePort,
  scope: MilestoneOwnerScope | null,
  isScopeCurrent: (scope: MilestoneOwnerScope) => boolean,
) {
  const bound = validScope(scope) ? Object.freeze({ ...scope }) : null;
  const current = () => bound !== null && isScopeCurrent(bound);
  const owned = (id: string) => current() && store.getState().items.some(
    (item) => item.id === id && milestoneBelongsToScope(item, bound));
  return {
    list: () => current() ? store.getState().items.filter((item) => milestoneBelongsToScope(item, bound)) : [],
    add(title: string, kind: MilestoneKind, requestId: string, description?: string, deadlineAt?: number) {
      if (!current() || !bound || typeof requestId !== 'string' || !requestId.trim())
        throw new Error('A current milestone owner scope and creation identity are required.');
      return store.getState().addMilestone(title, kind, description, deadlineAt,
        { ...bound, requestId });
    },
    update(id: string, patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status' | 'deadlineAt'>>) {
      if (!owned(id)) return false;
      store.getState().updateMilestone(id, patch);
      return true;
    },
    remove(id: string) {
      if (!owned(id)) return false;
      store.getState().removeMilestone(id);
      return true;
    },
    toggle(id: string) {
      if (!owned(id)) return false;
      store.getState().toggleDone(id);
      return true;
    },
    clearCompletedTodos() {
      const ids = store.getState().items.filter((item) => current() &&
        milestoneBelongsToScope(item, bound) && item.kind !== 'milestone' && item.status === 'done')
        .map((item) => item.id);
      return ids.filter((id) => {
        if (!owned(id)) return false;
        store.getState().removeMilestone(id);
        return true;
      });
    },
  };
}
