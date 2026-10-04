import { recycleBinStore } from '@/features/recycle-bin/recycleBinStore';
/** Local text recovery only: never stores microphone audio or provider credentials. */
const PREFIX = 'vibespace:speech-history:v1:';
const CHANGED = 'vibespace:speech-history-changed';
export type SpeechHistoryStatus = 'saved' | 'completed' | 'interrupted';
export interface SpeechHistoryEntry {
  id: string;
  startedAt: number;
  updatedAt?: number;
  text: string;
  provider: string;
  status: SpeechHistoryStatus;
}

let storageFailed = false;
const notify = () => window.dispatchEvent(new Event(CHANGED));
export const speechHistoryStorageFailed = () => storageFailed;

function scanSpeechHistory(): SpeechHistoryEntry[] | null {
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
          (row.updatedAt === undefined || Number.isFinite(row.updatedAt)) &&
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
    return null;
  }
  return rows.sort(
    (a, b) =>
      (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt) || b.id.localeCompare(a.id),
  );
}

export function readSpeechHistory(): SpeechHistoryEntry[] {
  return scanSpeechHistory()?.slice(0, 50) ?? [];
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
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return true;
    const entry = JSON.parse(raw) as SpeechHistoryEntry;
    recycleBinStore.archiveContent('speech', entry.id, entry.text.trim().slice(0, 100), entry);
    localStorage.removeItem(PREFIX + id);
    notify();
    return true;
  } catch {
    storageFailed = true;
    notify();
    return false;
  }
}

function pruneSpeechHistory() {
  const scanned = scanSpeechHistory();
  if (!scanned) throw new Error('Could not read speech history for retention');
  const retained = new Set(scanned.slice(0, 50).map((row) => PREFIX + row.id));
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX) && !retained.has(key)) remove.push(key);
  }
  for (const key of remove) {
    if (!deleteSpeechHistoryEntry(key.slice(PREFIX.length)))
      throw new Error('Could not archive older speech');
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
    entry.updatedAt = Date.now();
    try {
      // Individual keys prevent stale WebViews from overwriting each other's sessions.
      // A missing previously saved key also respects deletion in another window.
      if (persisted && localStorage.getItem(PREFIX + entry.id) === null) {
        deleted = true;
        return;
      }
      localStorage.setItem(PREFIX + entry.id, JSON.stringify(entry));
      persisted = true;
      pruneSpeechHistory();
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
    markInterrupted() {
      if (deleted) return;
      finished = true;
      entry.status = 'interrupted';
      save();
    },
    clear() {
      confirmed = '';
      partial = '';
      entry.text = '';
      try {
        if (persisted) {
          if (localStorage.getItem(PREFIX + entry.id) === null) {
            deleted = true;
            return;
          }
          localStorage.removeItem(PREFIX + entry.id);
          persisted = false;
        }
        storageFailed = false;
      } catch {
        storageFailed = true;
      }
      notify();
    },
  };
}

export function restoreSpeechHistoryEntry(entry: SpeechHistoryEntry): string {
  // A fresh identity protects a restored take from a still-running original session.
  const restored = {
    ...entry,
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: entry.status === 'saved' ? 'interrupted' : entry.status,
  };
  localStorage.setItem(PREFIX + restored.id, JSON.stringify(restored));
  try {
    pruneSpeechHistory();
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
  notify();
  return restored.id;
}
