import { parseCanvasDocument, type CanvasDocument } from './contracts';
import { bindCanvasWorkspaceFlush } from '@/lib/persistence/canvasWorkspaceFlush';

export type CanvasPersistenceStatus =
  | 'saved'
  | 'saving'
  | 'offline'
  | 'local-only'
  | 'syncing'
  | 'sync-error'
  | 'recovered-unsaved-work';

export interface CanvasRecoveryEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly baseRevision: number;
  readonly createdAt: number;
  readonly document: CanvasDocument;
}

export interface CanvasSaveRequest {
  readonly document: CanvasDocument;
  readonly expectedRevision: number;
  readonly recoveryId: string;
}

export interface CanvasSaveResult {
  readonly status: 'saved' | 'offline' | 'local-only' | 'syncing';
  readonly persistedRevision: number;
}

export interface CanvasPersistencePort {
  writeRecovery(entry: CanvasRecoveryEntry): Promise<void>;
  saveDocument(request: CanvasSaveRequest): Promise<CanvasSaveResult>;
  clearRecovery(recoveryId: string): Promise<void>;
}

export interface CanvasAutosaveState {
  readonly status: CanvasPersistenceStatus;
  readonly pending: boolean;
  readonly persistedRevision: number;
  readonly error: string | null;
}

export interface CanvasAutosaveOptions {
  readonly persistence: CanvasPersistencePort;
  readonly initialRevision: number;
  readonly delayMs?: number;
  readonly now?: () => number;
}

export interface CanvasAutosaveController {
  getState(): CanvasAutosaveState;
  getRecovery(): CanvasRecoveryEntry | null;
  subscribe(listener: (state: CanvasAutosaveState) => void): () => void;
  schedule(document: CanvasDocument): void;
  flush(): Promise<void>;
  retry(): Promise<void>;
  dispose(): Promise<void>;
}

export class CanvasAutosaveError extends Error {
  constructor(
    readonly code: 'invalid-options' | 'stale-document',
    message: string,
  ) {
    super(message);
    this.name = 'CanvasAutosaveError';
  }
}

export class CanvasPersistenceConflictError extends Error {
  constructor(message = 'Canvas persistence revision conflict') {
    super(message);
    this.name = 'CanvasPersistenceConflictError';
  }
}

const DEFAULT_DELAY_MS = 0;
const MAX_DELAY_MS = 60_000;

function safeInteger(value: number, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new CanvasAutosaveError('invalid-options', `${path} must be a non-negative integer`);
  }
  return value;
}

function recoveryEntry(
  document: CanvasDocument,
  baseRevision: number,
  createdAt: number,
  sequence: number,
): CanvasRecoveryEntry {
  return Object.freeze({
    schemaVersion: 1,
    id: `canvas-recovery:${document.id}:${document.localRevision}:${createdAt}:${sequence}`,
    documentId: document.id,
    projectId: document.projectId,
    ownerId: document.ownerId,
    baseRevision,
    createdAt,
    document,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown canvas persistence failure';
}

export function createCanvasAutosaveController(
  options: CanvasAutosaveOptions,
): CanvasAutosaveController {
  const initialRevision = safeInteger(options.initialRevision, 'initialRevision');
  const delayMs = safeInteger(options.delayMs ?? DEFAULT_DELAY_MS, 'delayMs', MAX_DELAY_MS);
  const now = options.now ?? Date.now;
  let state: CanvasAutosaveState = Object.freeze({
    status: 'local-only',
    pending: false,
    persistedRevision: initialRevision,
    error: null,
  });
  let pendingDocument: CanvasDocument | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let latestRecovery: CanvasRecoveryEntry | null = null;
  let recoverySequence = 0;
  let disposed = false;
  let disposing = false;
  let disposePromise: Promise<void> | null = null;
  const listeners = new Set<(state: CanvasAutosaveState) => void>();

  const publish = (change: Partial<CanvasAutosaveState>) => {
    state = Object.freeze({ ...state, ...change });
    for (const listener of listeners) listener(state);
  };

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const persistNext = async (document: CanvasDocument): Promise<boolean> => {
    recoverySequence += 1;
    const entry = recoveryEntry(
      document,
      state.persistedRevision,
      safeInteger(now(), 'now'),
      recoverySequence,
    );
    latestRecovery = entry;
    publish({ status: 'saving', pending: true, error: null });
    try {
      await options.persistence.writeRecovery(entry);
      const result = await options.persistence.saveDocument({
        document,
        expectedRevision: entry.baseRevision,
        recoveryId: entry.id,
      });
      const persistedRevision = safeInteger(result.persistedRevision, 'persistedRevision');
      if (persistedRevision !== document.localRevision) {
        throw new CanvasPersistenceConflictError(
          'Persistence returned a revision that does not match the saved document',
        );
      }
      await options.persistence.clearRecovery(entry.id);
      latestRecovery = null;
      publish({
        status: result.status,
        pending: pendingDocument !== null,
        persistedRevision,
        error: null,
      });
      return true;
    } catch (error) {
      pendingDocument ??= document;
      publish({
        status:
          error instanceof CanvasPersistenceConflictError ? 'recovered-unsaved-work' : 'sync-error',
        pending: true,
        error: errorMessage(error),
      });
      return false;
    }
  };

  const drainPending = async (): Promise<void> => {
    // Persist the newest pending document, then keep draining any edit that was
    // scheduled while a save was already in flight, so an explicit lifecycle
    // flush resolves only after the latest edit is durable. Stop on failure so
    // retry() (not a tight loop) owns recovery of a persistently failing save.
    while (pendingDocument !== null && !disposed) {
      const document = pendingDocument;
      pendingDocument = null;
      const saved = await persistNext(document);
      if (!saved) break;
    }
  };

  const flush = async (): Promise<void> => {
    if (disposed) return;
    cancelTimer();
    while (!disposed) {
      if (!inFlight) {
        const drain = drainPending();
        const trackedDrain = drain.finally(() => {
          if (inFlight === trackedDrain) inFlight = null;
        });
        inFlight = trackedDrain;
      }
      await inFlight;

      // A failed save intentionally leaves the newest document pending for an
      // explicit retry. Returning here avoids a tight retry loop that can
      // exhaust memory while preserving the recovery journal and error state.
      if (state.status === 'sync-error' || state.status === 'recovered-unsaved-work') return;

      // Re-check after every tracked drain. This closes the narrow lifecycle
      // race where a new edit becomes pending after the drain observes an
      // empty queue but before callers resume from the settled promise.
      if (pendingDocument === null) return;
    }
  };

  const controller: CanvasAutosaveController = {
    getState: () => state,
    getRecovery: () => latestRecovery,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    schedule(rawDocument) {
      if (disposed || disposing) return;
      const document = parseCanvasDocument(rawDocument);
      if (document.localRevision < state.persistedRevision) {
        throw new CanvasAutosaveError(
          'stale-document',
          'Cannot schedule a document older than the persisted revision',
        );
      }
      pendingDocument = document;
      publish({ pending: true, error: null });
      cancelTimer();
      if (delayMs === 0) {
        // Begin the recovery journal and transactional save before returning
        // to the browser event loop. The controller still coalesces edits that
        // arrive while a save is in flight, so pointer-heavy Canvas work does
        // not create an unbounded write queue.
        void flush();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    },
    flush,
    retry: flush,
    dispose() {
      if (disposePromise) return disposePromise;
      disposing = true;
      cancelTimer();
      disposePromise = flush().finally(() => {
        disposed = true;
        disposing = false;
        cancelTimer();
        listeners.clear();
      });
      return disposePromise;
    },
  };
  return Object.freeze(controller);
}

/**
 * Bind a Canvas autosave controller into the awaitable workspace flush
 * lifecycle. Workspace flushes (tray-hide, updater relaunch, unload) await the
 * controller's flush so the newest Canvas edit is durable before they resolve.
 * Returns an unbind function.
 */
export function registerCanvasWorkspaceFlush(controller: CanvasAutosaveController): () => void {
  return bindCanvasWorkspaceFlush(async () => {
    await controller.flush();
    const state = controller.getState();
    if (
      state.status === 'sync-error' ||
      state.status === 'recovered-unsaved-work' ||
      (state.pending && state.error)
    ) {
      throw new Error(state.error ?? `Canvas persistence flush ended in ${state.status}`);
    }
  });
}
