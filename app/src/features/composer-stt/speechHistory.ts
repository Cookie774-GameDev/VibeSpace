/** Local text recovery only: never stores microphone audio or provider credentials. */
const PREFIX = 'vibespace:speech-history:v1:';
const CHANGED = 'vibespace:speech-history-changed';
export type SpeechHistoryStatus = 'saved' | 'completed' | 'interrupted';
export interface SpeechHistoryEntry {
  id: string;
  startedAt: number;
  text: string;
  provider: string;
  status: SpeechHistoryStatus;
}

let storageFailed = false;
const notify = () => window.dispatchEvent(new Event(CHANGED));
export const speechHistoryStorageFailed = () => storageFailed;

export function readSpeechHistory(): SpeechHistoryEntry[] {
  const rows: SpeechHistoryEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const row = JSON.parse(localStorage.getItem(key) ?? 'null') as SpeechHistoryEntry;
        if (
          row &&
          typeof row.id === 'string' &&
          key === PREFIX + row.id &&
          Number.isFinite(row.startedAt) &&
          typeof row.text === 'string' &&
          row.text.trim() &&
          typeof row.provider === 'string' &&
          ['saved', 'completed', 'interrupted'].includes(row.status)
        )
          rows.push(row);
      } catch {
        /* A damaged entry must not hide other recovered speech. */
      }
    }
  } catch {
    storageFailed = true;
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).slice(0, 50);
}

export function subscribeSpeechHistory(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function deleteSpeechHistoryEntry(id: string): boolean {
  try {
    localStorage.removeItem(PREFIX + id);
    notify();
    return true;
  } catch {
    storageFailed = true;
    notify();
    return false;
  }
}

export function createSpeechHistorySession(provider: string) {
  const entry: SpeechHistoryEntry = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    text: '',
    provider,
    status: 'saved',
  };
  let confirmed = '';
  let partial = '';
  let persisted = false;
  let deleted = false;
  let finished = false;
  const save = () => {
    entry.text = [confirmed, partial].filter(Boolean).join(' ').trim();
    if (!entry.text || deleted) return;
    try {
      // Individual keys prevent stale WebViews from overwriting each other's sessions.
      // A missing previously saved key also respects deletion in another window.
      if (persisted && localStorage.getItem(PREFIX + entry.id) === null) {
        deleted = true;
        return;
      }
      localStorage.setItem(PREFIX + entry.id, JSON.stringify(entry));
      persisted = true;
      const retained = new Set(readSpeechHistory().map((row) => PREFIX + row.id));
      const remove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX) && !retained.has(key)) remove.push(key);
      }
      for (const key of remove) localStorage.removeItem(key);
      storageFailed = false;
    } catch {
      storageFailed = true;
    }
    notify();
  };
  return {
    partial(text: string) {
      if (!finished) {
        partial = text.trim();
        save();
      }
    },
    final(text: string) {
      if (finished || !text.trim()) return;
      confirmed =
        provider === 'deepgram' ? [confirmed, text.trim()].filter(Boolean).join(' ') : text.trim();
      partial = '';
      save();
    },
    finish(status: Exclude<SpeechHistoryStatus, 'saved'>) {
      if (finished) return;
      finished = true;
      entry.status = status;
      save();
    },
  };
}
