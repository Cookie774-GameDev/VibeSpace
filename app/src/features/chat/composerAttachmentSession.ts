import { useMemo, useSyncExternalStore, type SetStateAction } from 'react';
import type { QueuedComposerAttachments } from './Composer';

type Attachments = Pick<QueuedComposerAttachments, 'files' | 'images' | 'terminals' | 'plugins' | 'contexts'>;

function createSession() {
  let attachments: Attachments = { files: [], images: [], terminals: [], plugins: [], contexts: [] };
  const listeners = new Set<() => void>();
  function setter<K extends keyof Attachments>(key: K) {
    return (update: SetStateAction<Attachments[K]>) => {
      const value = typeof update === 'function' ? update(attachments[key]) : update;
      attachments = { ...attachments, [key]: value };
      for (const listener of listeners) listener();
    };
  }
  return {
    getSnapshot: () => attachments,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setAttachedFiles: setter('files'),
    setAttachedImages: setter('images'),
    setAttachedTerminals: setter('terminals'),
    setAttachedPlugins: setter('plugins'),
    setAttachedContexts: setter('contexts'),
  };
}

// Match composerQueueSession's privacy contract: private attachment contents stay
// in runtime memory, scoped to account/workspace/project/chat, through view changes.
const sessions = new Map<string, ReturnType<typeof createSession>>();

export function useComposerAttachmentSession(scope: string) {
  const session = useMemo(() => {
    let existing = sessions.get(scope);
    if (!existing) {
      existing = createSession();
      sessions.set(scope, existing);
    }
    return existing;
  }, [scope]);
  const attachments = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { ...session, attachments };
}
