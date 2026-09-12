import { create } from 'zustand';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import type { collectAuditEvidence } from './auditEvidence';

export type AuditStatus = 'ready' | 'waiting' | 'preparing' | 'running' | 'complete' | 'error';
export type AuditOptions = { auditor: 'new' | 'main'; interrupt: boolean };
export type AuditSession = {
  id: string;
  scope: string;
  sourceId: string;
  title: string;
  minimized: boolean;
  status: AuditStatus;
  stage: string;
  progress: number;
  report: string;
  scrollTop?: number;
  error?: string;
  targetId?: string;
  evidence?: ReturnType<typeof collectAuditEvidence>;
  options: AuditOptions;
};
export const currentAuditScope = () => {
  const auth = useAuthStore.getState();
  return JSON.stringify([
    resolveAccountIdentity(auth)?.accountId,
    auth.workspaceId,
    auth.projectId,
  ]);
};
export const useVibeCheckStore = create<{ session: AuditSession | null }>(() => ({
  session: null,
}));
let dispose: (() => void) | undefined;
export function registerAuditCleanup(cleanup: () => void) {
  dispose?.();
  dispose = cleanup;
}
export function patchAudit(id: string, patch: Partial<AuditSession>) {
  useVibeCheckStore.setState((state) =>
    state.session?.id === id ? { session: { ...state.session, ...patch } } : state,
  );
}
export function closeVibeCheck() {
  dispose?.();
  dispose = undefined;
  useVibeCheckStore.setState({ session: null });
}
export function openVibeCheck(sourceId: string) {
  const previous = useVibeCheckStore.getState().session;
  if (previous?.sourceId === sourceId && previous.scope === currentAuditScope()) {
    patchAudit(previous.id, { minimized: false });
    if (previous.status === 'complete' || previous.status === 'error') {
      void import('./vibeCheckService')
        .then((module) => {
          if (useVibeCheckStore.getState().session?.id === previous.id)
            return module.startVibeCheck(previous.options);
        })
        .catch((error) => patchAudit(previous.id, { status: 'error', error: String(error) }));
    }
    return;
  }
  closeVibeCheck();
  useVibeCheckStore.setState({
    session: {
      id: crypto.randomUUID(),
      scope: currentAuditScope(),
      sourceId,
      title: 'VibeCheck',
      minimized: false,
      status: 'ready',
      stage: 'Choose your auditor',
      progress: 0,
      report: '',
      options: { auditor: 'new', interrupt: false },
    },
  });
}
useAuthStore.subscribe((next, previous) => {
  if (
    next.workspaceId !== previous.workspaceId ||
    next.projectId !== previous.projectId ||
    resolveAccountIdentity(next)?.accountId !== resolveAccountIdentity(previous)?.accountId
  )
    closeVibeCheck();
});
