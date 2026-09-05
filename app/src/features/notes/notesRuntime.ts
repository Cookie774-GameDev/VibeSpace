import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { createNotesAuthority } from './notesAuthority';
import { createNotesWorkspace, type NotesWorkspace, type NotesSnapshot } from './notesWorkspace';
import { noteScopeKey, sameNoteScope, type NoteScope } from './notesContracts';

export function currentNoteScope(): NoteScope | null {
  const auth = useAuthStore.getState();
  const accountId = resolveAccountIdentity(auth)?.accountId;
  return accountId && auth.projectId ? { accountId, projectId: String(auth.projectId) } : null;
}
function assertCurrentScope(scope: NoteScope): void {
  const current = currentNoteScope();
  if (!current || !sameNoteScope(current, scope)) {
    throw new Error(
      'The active account or project changed. Return to this note’s project to save or attach it.',
    );
  }
}
const authority = createNotesAuthority(undefined, assertCurrentScope);
const workspaces = new Map<string, NotesWorkspace>();
let lifecycleBound = false;
export function getNotesWorkspace(scope: NoteScope): NotesWorkspace {
  assertCurrentScope(scope);
  const key = noteScopeKey(scope);
  let workspace = workspaces.get(key);
  if (!workspace) {
    workspace = createNotesWorkspace(scope, {
      authority,
      storage: window.localStorage,
      assertActive: () => assertCurrentScope(scope),
    });
    workspaces.set(key, workspace);
  }
  if (!lifecycleBound) {
    lifecycleBound = true;
    const checkpoint = () => {
      for (const store of workspaces.values()) store.checkpoint();
      const current = currentNoteScope();
      if (current)
        void workspaces
          .get(noteScopeKey(current))
          ?.flushAll()
          .catch(() => undefined);
    };
    window.addEventListener('pagehide', checkpoint);
    window.addEventListener('beforeunload', checkpoint);
  }
  return workspace;
}
export function useNoteScope(): NoteScope | null {
  const accountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? null);
  const projectId = useAuthStore((s) => s.projectId);
  return useMemo(
    () => (accountId && projectId ? { accountId, projectId: String(projectId) } : null),
    [accountId, projectId],
  );
}
const emptySnapshot: NotesSnapshot = Object.freeze({
  notes: [],
  activeId: null,
  active: null,
  status: 'empty',
  error: null,
  checkpointError: null,
  listWidth: 284,
  loading: false,
  pendingCount: 0,
});
const emptySubscribe = () => () => undefined;
const getEmptySnapshot = () => emptySnapshot;
export function useNotesWorkspace(scope: NoteScope | null, enabled = true) {
  const workspace = useMemo(() => (scope ? getNotesWorkspace(scope) : null), [scope]);
  const snapshot = useSyncExternalStore(
    workspace?.subscribe ?? emptySubscribe,
    workspace?.getSnapshot ?? getEmptySnapshot,
    getEmptySnapshot,
  );
  useEffect(() => {
    if (!workspace || !enabled) return;
    workspace.resume();
    void workspace
      .refresh()
      .then(() => {
        const { activeId, active } = workspace.getSnapshot();
        if (activeId && !active) return workspace.select(activeId);
      })
      .catch(() => undefined);
    return () => {
      workspace.checkpoint();
      void workspace.flushAll().catch(() => undefined);
    };
  }, [workspace, enabled]);
  return { workspace, snapshot };
}
export function openNoteReference(ref: NoteScope & { id: string }): void {
  assertCurrentScope(ref);
  const workspace = getNotesWorkspace(ref);
  void workspace.select(ref.id).catch(() => undefined);
  useUIStore.getState().setRoute('notes');
}
