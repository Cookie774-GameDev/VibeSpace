import {
  MAX_NOTES,
  notePreview,
  noteScopeKey,
  noteSummary,
  parseNoteRecord,
  parseNoteSummary,
  type NotePatch,
  type NoteRecord,
  type NoteScope,
  type NoteSummary,
  type NotesAuthority,
  type NotesCheckpointStorage,
} from './notesContracts';

type Attempt = { record: NoteRecord; expected: string | null };
type Entry = {
  record: NoteRecord;
  base: string | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  attempt?: Attempt;
};
export interface NotesSnapshot {
  notes: readonly NoteSummary[];
  activeId: string | null;
  active: NoteRecord | null;
  status: 'empty' | 'loading' | 'draft' | 'saving' | 'saved' | 'error';
  error: string | null;
  checkpointError: string | null;
  listWidth: number;
  loading: boolean;
  pendingCount: number;
}
interface WorkspaceOptions {
  authority: NotesAuthority;
  storage: NotesCheckpointStorage;
  saveDelayMs?: number;
  assertActive?: () => void;
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Notes could not be saved. Retry when storage is available.';
}

export class NotesWorkspace {
  private entries = new Map<string, Entry>();
  private summaries = new Map<string, NoteSummary>();
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saves = new Map<string, Promise<void>>();
  private refreshTask: Promise<void> | null = null;
  private activeId: string | null = null;
  private loadingId: string | null = null;
  private listWidth = 284;
  private loading = false;
  private error: string | null = null;
  private checkpointError: string | null = null;
  private damagedCheckpoint = false;
  private snapshot!: NotesSnapshot;
  private readonly key: string;
  constructor(
    readonly scope: NoteScope,
    private readonly options: WorkspaceOptions,
  ) {
    this.key = `vibespace:notes:drafts:v1:${noteScopeKey(scope)}`;
    this.restore();
    this.publish();
  }
  getSnapshot = (): NotesSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private guard(): void {
    this.options.assertActive?.();
  }
  private publish(): void {
    const entry = this.activeId ? this.entries.get(this.activeId) : undefined;
    this.snapshot = {
      notes: [...this.summaries.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      ),
      activeId: this.activeId,
      active: entry ? { ...entry.record } : null,
      status: entry
        ? entry.error
          ? 'error'
          : entry.saving
            ? 'saving'
            : entry.dirty
              ? 'draft'
              : 'saved'
        : this.loadingId === this.activeId && this.activeId
          ? 'loading'
          : this.error
            ? 'error'
            : 'empty',
      error: entry?.error ?? this.error,
      checkpointError: this.checkpointError,
      listWidth: this.listWidth,
      loading: this.loading,
      pendingCount: [...this.entries.values()].filter((e) => e.dirty).length,
    };
    for (const listener of this.listeners) listener();
  }
  private restore(): void {
    try {
      const raw = this.options.storage.getItem(this.key);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        version: number;
        scope: NoteScope;
        notes: unknown[];
        drafts: {
          record: unknown;
          base: string | null;
          error?: string;
          attempt?: { record: unknown; expected: string | null };
        }[];
        activeId: string | null;
        listWidth: number;
      };
      if (
        saved.version !== 1 ||
        noteScopeKey(saved.scope) !== noteScopeKey(this.scope) ||
        !Array.isArray(saved.notes) ||
        !Array.isArray(saved.drafts) ||
        saved.notes.length > MAX_NOTES ||
        saved.drafts.length > MAX_NOTES
      )
        throw new Error('Invalid checkpoint');
      for (const value of saved.notes) {
        const summary = parseNoteSummary(value, this.scope);
        this.summaries.set(summary.id, summary);
      }
      for (const value of saved.drafts) {
        const record = parseNoteRecord(value.record, this.scope);
        const attempt = value.attempt
          ? {
              record: parseNoteRecord(value.attempt.record, this.scope),
              expected: value.attempt.expected,
            }
          : undefined;
        if (
          (value.base !== null && typeof value.base !== 'string') ||
          (attempt && attempt.record.id !== record.id)
        )
          throw new Error('Invalid draft');
        this.entries.set(record.id, {
          record,
          base: value.base,
          dirty: true,
          saving: false,
          error: typeof value.error === 'string' ? value.error : null,
          ...(attempt ? { attempt } : {}),
        });
        this.summaries.set(record.id, noteSummary(record));
      }
      this.activeId = saved.activeId && this.summaries.has(saved.activeId) ? saved.activeId : null;
      this.listWidth = Number.isFinite(saved.listWidth)
        ? Math.max(200, Math.min(480, saved.listWidth))
        : 284;
    } catch {
      this.damagedCheckpoint = true;
      this.checkpointError =
        'Stored draft checkpoint could not be read. It has not been overwritten or deleted.';
    }
  }
  checkpoint(): void {
    if (this.damagedCheckpoint) return;
    try {
      const drafts = [...this.entries.values()]
        .filter((e) => e.dirty)
        .map((e) => ({
          record: e.record,
          base: e.base,
          error: e.error,
          ...(e.attempt ? { attempt: e.attempt } : {}),
        }));
      this.options.storage.setItem(
        this.key,
        JSON.stringify({
          version: 1,
          scope: this.scope,
          notes: [...this.summaries.values()],
          drafts,
          activeId: this.activeId,
          listWidth: this.listWidth,
        }),
      );
      this.checkpointError = null;
    } catch {
      this.checkpointError =
        'Local draft checkpoint failed. Keep this window open and retry saving to SiYuan.';
    }
  }
  private schedule(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.flush(id).catch(() => undefined);
      }, this.options.saveDelayMs ?? 650),
    );
  }
  private evictSavedBodies(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 6) break;
      if (id !== this.activeId && !entry.dirty && !entry.saving) this.entries.delete(id);
    }
  }
  create(seed: NotePatch = {}): string {
    this.guard();
    if (this.summaries.size >= MAX_NOTES) throw new Error('This Notes collection is full.');
    if (this.activeId) void this.flush(this.activeId).catch(() => undefined);
    const now = Date.now();
    const record = parseNoteRecord(
      {
        ...this.scope,
        id: `note-${crypto.randomUUID()}`,
        title: seed.title || 'Untitled note',
        body: seed.body ?? '',
        preview: notePreview(seed.body ?? ''),
        revision: `rev-${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        pinned: seed.pinned ?? false,
        favorite: seed.favorite ?? false,
        trashed: false,
      },
      this.scope,
    );
    this.entries.set(record.id, { record, base: null, dirty: true, saving: false, error: null });
    this.summaries.set(record.id, noteSummary(record));
    this.activeId = record.id;
    this.loadingId = null;
    this.error = null;
    this.checkpoint();
    this.publish();
    this.schedule(record.id);
    return record.id;
  }
  edit(id: string, patch: NotePatch): void {
    this.guard();
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Open this note before editing it.');
    const body = patch.body ?? entry.record.body;
    const record = parseNoteRecord(
      {
        ...entry.record,
        body,
        title: patch.title ?? entry.record.title,
        pinned: patch.pinned ?? entry.record.pinned,
        favorite: patch.favorite ?? entry.record.favorite,
        trashed: patch.trashed ?? entry.record.trashed,
        preview: notePreview(body),
        revision: `rev-${crypto.randomUUID()}`,
        updatedAt: Math.max(Date.now(), entry.record.updatedAt),
      },
      this.scope,
    );
    entry.record = record;
    entry.dirty = true;
    entry.error = null;
    this.summaries.set(id, noteSummary(record));
    this.checkpoint();
    this.publish();
    this.schedule(id);
  }
  flush(id: string): Promise<void> {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const running = this.saves.get(id);
    if (running) return running;
    const complete: Promise<void> = Promise.resolve()
      .then(() => this.drain(id))
      .finally(() => {
        if (this.saves.get(id) === complete) this.saves.delete(id);
      });
    this.saves.set(id, complete);
    return complete;
  }
  private async drain(id: string): Promise<void> {
    let entry = this.entries.get(id);
    while (entry?.dirty) {
      this.guard();
      // Persist the exact attempted revision before I/O: interrupted creates can be retried safely.
      const attempt = entry.attempt ?? { record: { ...entry.record }, expected: entry.base };
      entry.attempt = attempt;
      entry.saving = true;
      entry.error = null;
      this.checkpoint();
      this.publish();
      try {
        const saved = parseNoteRecord(
          await this.options.authority.write(this.scope, attempt.record, attempt.expected),
          this.scope,
        );
        this.guard();
        if (saved.id !== id) throw new Error('Notes storage returned an unexpected identity.');
        entry.base = saved.revision;
        if (entry.record.revision === attempt.record.revision) {
          entry.record = saved;
          entry.dirty = false;
        } else {
          entry.record = { ...entry.record, nativeId: saved.nativeId };
        }
        entry.attempt = undefined;
        entry.error = null;
        entry.saving = false;
        this.summaries.set(id, noteSummary(entry.record));
        this.markMutation(id);
        this.checkpoint();
        this.evictSavedBodies();
        this.publish();
      } catch (error) {
        entry.error = message(error);
        entry.saving = false;
        this.checkpoint();
        this.publish();
        throw error;
      }
      entry = this.entries.get(id);
    }
  }
  async resolve(ids: readonly string[]): Promise<NoteRecord[]> {
    const records: NoteRecord[] = [];
    for (const id of new Set(ids)) {
      this.guard();
      await this.flush(id);
      const record = parseNoteRecord(await this.options.authority.read(this.scope, id), this.scope);
      this.guard();
      if (record.id !== id)
        throw new Error('Note identity changed. Remove this reference and select it again.');
      if (record.trashed)
        throw new Error('This note is in Trash. Restore it or remove its reference.');
      records.push(record);
    }
    return records;
  }
  saveCopy(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Open this note before saving a copy.');
    return this.create({ ...entry.record, title: `${entry.record.title.slice(0, 235)} (copy)` });
  }
  private loads = new Map<string, number>();
  private mutations = new Map<string, number>();
  private mutationClock = 0;
  private markMutation(id: string): void {
    this.mutations.set(id, ++this.mutationClock);
  }
  async select(id: string): Promise<void> {
    this.guard();
    if (this.activeId && this.activeId !== id)
      void this.flush(this.activeId).catch(() => undefined);
    const generation = (this.loads.get(id) ?? 0) + 1;
    this.loads.set(id, generation);
    this.activeId = id;
    this.error = null;
    this.loadingId = this.entries.has(id) ? null : id;
    this.checkpoint();
    this.publish();
    if (this.entries.has(id)) return;
    try {
      const record = parseNoteRecord(await this.options.authority.read(this.scope, id), this.scope);
      this.guard();
      if (record.id !== id) throw new Error('The requested note is unavailable.');
      if (this.loads.get(id) !== generation || this.entries.get(id)?.dirty) return;
      this.entries.set(id, {
        record,
        base: record.revision,
        dirty: false,
        saving: false,
        error: null,
      });
      this.summaries.set(id, noteSummary(record));
      this.evictSavedBodies();
      this.checkpoint();
    } catch (error) {
      if (this.activeId === id && this.loads.get(id) === generation) this.error = message(error);
      throw error;
    } finally {
      if (this.activeId === id && this.loads.get(id) === generation) this.loadingId = null;
      this.publish();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    this.guard();
    const startedAt = this.mutationClock;
    this.loading = true;
    this.error = null;
    this.publish();
    const task = (async () => {
      try {
        const remote = await this.options.authority.list(this.scope);
        this.guard();
        if (remote.length > MAX_NOTES) throw new Error('This Notes collection is too large.');
        const next = new Map(
          remote.map((value) => {
            const summary = parseNoteSummary(value, this.scope);
            return [summary.id, summary] as const;
          }),
        );
        for (const [id, summary] of this.summaries) {
          if (this.entries.get(id)?.dirty || (this.mutations.get(id) ?? 0) > startedAt)
            next.set(id, summary);
        }
        for (const [id, entry] of this.entries) {
          if (!entry.dirty && next.get(id)?.revision !== entry.record.revision)
            this.entries.delete(id);
        }
        this.summaries = next;
        if (this.activeId && !next.has(this.activeId)) this.activeId = null;
        this.checkpoint();
      } catch (error) {
        this.error = message(error);
        throw error;
      } finally {
        this.loading = false;
        this.publish();
      }
    })();
    this.refreshTask = task.finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  setListWidth(width: number, persist = true): void {
    this.guard();
    this.listWidth = Number.isFinite(width) ? Math.max(200, Math.min(480, Math.round(width))) : 284;
    if (persist) this.checkpoint();
    this.publish();
  }
  resume(): void {
    this.guard();
    for (const [id, entry] of this.entries) if (entry.dirty) this.schedule(id);
  }
  async flushAll(): Promise<void> {
    this.checkpoint();
    await Promise.all([...this.entries.keys()].map((id) => this.flush(id)));
  }
  dispose(): void {
    this.checkpoint();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}
export function createNotesWorkspace(scope: NoteScope, options: WorkspaceOptions): NotesWorkspace {
  return new NotesWorkspace(scope, options);
}
