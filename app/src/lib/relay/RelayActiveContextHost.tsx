import * as React from 'react';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import {
  closeRelayActiveContext,
  openRelayActiveContext,
  updateRelayActiveContext,
  type RelayActiveContext,
} from '@/lib/tauri';

/** Mirrors the selected main-window chat for native generation/scope checks. */
export function RelayActiveContextHost() {
  const activeChatId = useUIStore((state) => state.activeChatId);
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);
  const context = React.useMemo<RelayActiveContext | null>(() => {
    if (!accountId || !projectId || !activeChatId) return null;
    return {
      accountId,
      workspaceId: workspaceId ? String(workspaceId) : null,
      projectId: String(projectId),
      chatId: String(activeChatId),
    };
  }, [accountId, activeChatId, projectId, workspaceId]);
  const contextRef = React.useRef(context);
  contextRef.current = context;
  const ownerRef = React.useRef<string | null>(null);
  const revisionRef = React.useRef(0);

  React.useEffect(() => {
    let disposed = false;
    void openRelayActiveContext()
      .then(async (owner) => {
        if (!owner) return;
        ownerRef.current = owner.ownerHandle;
        if (disposed) {
          await closeRelayActiveContext(owner.ownerHandle, ++revisionRef.current).catch(
            () => undefined,
          );
          return;
        }
        await updateRelayActiveContext(
          owner.ownerHandle,
          ++revisionRef.current,
          contextRef.current,
        ).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (ownerRef.current) {
        void closeRelayActiveContext(ownerRef.current, ++revisionRef.current).catch(
          () => undefined,
        );
        ownerRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    const owner = ownerRef.current;
    if (!owner) return;
    void updateRelayActiveContext(owner, ++revisionRef.current, context).catch(() => undefined);
  }, [context]);

  return null;
}
