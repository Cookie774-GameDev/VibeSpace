import { useMemo, useSyncExternalStore, type SetStateAction } from 'react';
import type { buildComposerChatHandoffPayload } from './Composer';
import type { QueuedChatMessage } from './composerQueuePolicy';

type Handoff = Readonly<{
  payload: ReturnType<typeof buildComposerChatHandoffPayload>;
  visibleHandoffKey: string;
}>;

function createSession() {
  let messages: QueuedChatMessage[] = [];
  const listeners = new Set<() => void>();
  return {
    // Runtime memory only: retains the complete snapshots through view changes,
    // without putting private attachments or handoffs into browser storage.
    handoffs: { current: new Map<string, Handoff>() },
    dispatchInFlight: { current: null as string | null },
    interruptInFlight: { current: null as string | null },
    suppressCancelFlush: { current: false },
    getSnapshot: () => messages,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setMessages: (update: SetStateAction<QueuedChatMessage[]>) => {
      messages = typeof update === 'function' ? update(messages) : update;
      for (const listener of listeners) listener();
    },
  };
}

const sessions = new Map<string, ReturnType<typeof createSession>>();

export function useComposerQueueSession(scope: string) {
  const session = useMemo(() => {
    let existing = sessions.get(scope);
    if (!existing) {
      existing = createSession();
      sessions.set(scope, existing);
    }
    return existing;
  }, [scope]);
  const messages = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { ...session, messages };
}
