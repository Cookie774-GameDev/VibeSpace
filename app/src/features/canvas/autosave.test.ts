import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasPersistenceConflictError,
  createCanvasAutosaveController,
  registerCanvasWorkspaceFlush,
  type CanvasPersistencePort,
} from './autosave';
import {
  createCanvasBlock,
  createCanvasDocument,
  withBlockAdded,
  withCamera,
  type CanvasDocument,
} from './contracts';
import {
  flushCanvasWorkspaceState,
  _resetCanvasFlushForTests,
} from '@/lib/persistence/canvasWorkspaceFlush';

function documentAt(revision: number, text = 'Draft'): CanvasDocument {
  let document = createCanvasDocument({
    id: 'canvas-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    now: 1,
  });
  for (let index = 0; index < revision; index += 1) {
    const now = index + 2;
    document = withBlockAdded(
      document,
      createCanvasBlock({
        id: `block-${index + 1}`,
        content: { kind: 'note', text: `${text} ${index + 1}` },
        now,
      }),
      now,
    );
  }
  return document;
}

function port(
  status: 'saved' | 'local-only' | 'offline' | 'syncing' = 'local-only',
): CanvasPersistencePort {
  return {
    writeRecovery: vi.fn(async () => undefined),
    saveDocument: vi.fn(async ({ document }) => ({
      status,
      persistedRevision: document.localRevision,
    })),
    clearRecovery: vi.fn(async () => undefined),
  };
}

describe('Canvas autosave controller', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetCanvasFlushForTests();
  });

  it('debounces rapid changes and incrementally saves only the latest document', async () => {
    vi.useFakeTimers();
    const persistence = port();
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
      delayMs: 250,
      now: () => 100,
    });
    controller.schedule(documentAt(1));
    controller.schedule(documentAt(2));

    expect(persistence.saveDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(persistence.saveDocument).toHaveBeenCalledOnce();
    expect(vi.mocked(persistence.saveDocument).mock.calls[0]?.[0].document.localRevision).toBe(2);
    expect(controller.getState()).toMatchObject({
      status: 'local-only',
      pending: false,
      persistedRevision: 2,
    });
  });

  it('starts the default coalesced durable save in the same turn as the edit', async () => {
    const persistence = port();
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
      now: () => 101,
    });

    controller.schedule(documentAt(1));

    expect(persistence.writeRecovery).toHaveBeenCalledOnce();
    await controller.flush();
    expect(persistence.saveDocument).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      pending: false,
      persistedRevision: 1,
    });
  });

  it('writes recovery data before a transactional save and clears it only after success', async () => {
    const order: string[] = [];
    const persistence: CanvasPersistencePort = {
      writeRecovery: vi.fn(async () => {
        order.push('journal');
      }),
      saveDocument: vi.fn(async ({ document, expectedRevision }) => {
        order.push(`save:${expectedRevision}`);
        return { status: 'saved' as const, persistedRevision: document.localRevision };
      }),
      clearRecovery: vi.fn(async () => {
        order.push('clear');
      }),
    };
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
      now: () => 200,
    });
    controller.schedule(documentAt(1));

    await controller.flush();

    expect(order).toEqual(['journal', 'save:0', 'clear']);
    expect(controller.getState().status).toBe('saved');
  });

  it('retains recovery data and supports retry after an ordinary save failure', async () => {
    const persistence = port();
    vi.mocked(persistence.saveDocument)
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ status: 'local-only', persistedRevision: 1 });
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
    });
    controller.schedule(documentAt(1));

    await controller.flush();
    expect(controller.getState()).toMatchObject({
      status: 'sync-error',
      pending: true,
    });
    expect(persistence.saveDocument).toHaveBeenCalledOnce();
    expect(persistence.clearRecovery).not.toHaveBeenCalled();

    await controller.retry();
    expect(controller.getState()).toMatchObject({
      status: 'local-only',
      pending: false,
    });
  });

  it('offers recovered unsaved work when optimistic concurrency conflicts', async () => {
    const persistence = port();
    vi.mocked(persistence.saveDocument).mockRejectedValue(
      new CanvasPersistenceConflictError('remote revision changed'),
    );
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
    });
    const draft = withCamera(documentAt(1), { x: 40, y: -20, zoom: 1.5 });
    controller.schedule(draft);

    await controller.flush();

    expect(controller.getState()).toMatchObject({
      status: 'recovered-unsaved-work',
      pending: true,
    });
    expect(controller.getRecovery()?.document.camera).toEqual({
      x: 40,
      y: -20,
      zoom: 1.5,
    });
  });

  it('explicit flush drains the newest document scheduled during an in-flight save before resolving', async () => {
    const savedRevisions: number[] = [];
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const persistence: CanvasPersistencePort = {
      writeRecovery: vi.fn(async () => undefined),
      saveDocument: vi.fn(async ({ document }) => {
        saveCalls += 1;
        if (saveCalls === 1) {
          await firstSaveGate;
        }
        savedRevisions.push(document.localRevision);
        return { status: 'local-only' as const, persistedRevision: document.localRevision };
      }),
      clearRecovery: vi.fn(async () => undefined),
    };
    const controller = createCanvasAutosaveController({ persistence, initialRevision: 0 });
    controller.schedule(documentAt(1));

    const firstFlush = controller.flush();
    await vi.waitFor(() => expect(persistence.saveDocument).toHaveBeenCalledTimes(1));

    // A newer edit arrives while the first save is still in flight.
    controller.schedule(documentAt(2));

    // An explicit lifecycle flush must drain that newest edit before resolving.
    const explicitFlush = controller.flush();
    expect(controller.getState().pending).toBe(true);

    releaseFirstSave?.();
    await Promise.all([firstFlush, explicitFlush]);

    expect(savedRevisions).toEqual([1, 2]);
    expect(persistence.saveDocument).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({
      status: 'local-only',
      pending: false,
      persistedRevision: 2,
    });
  });

  it('assigns unique recovery ids to same-millisecond camera-only revisions', async () => {
    const recoveryIds: string[] = [];
    const persistence: CanvasPersistencePort = {
      writeRecovery: vi.fn(async (entry) => {
        recoveryIds.push(entry.id);
      }),
      saveDocument: vi.fn(async ({ document }) => ({
        status: 'local-only' as const,
        persistedRevision: document.localRevision,
      })),
      clearRecovery: vi.fn(async () => undefined),
    };
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
      now: () => 500,
    });
    const base = documentAt(1);

    controller.schedule(withCamera(base, { x: 1, y: 1, zoom: 1 }));
    await controller.flush();
    controller.schedule(withCamera(base, { x: 9, y: 9, zoom: 2 }));
    await controller.flush();

    expect(recoveryIds).toHaveLength(2);
    expect(new Set(recoveryIds).size).toBe(2);
  });

  it('binds an awaitable Canvas flush into the isolated workspace flush registry', async () => {
    const persistence = port();
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
    });
    const cleanup = registerCanvasWorkspaceFlush(controller);
    controller.schedule(documentAt(1));

    await flushCanvasWorkspaceState('tray-hide');

    expect(persistence.saveDocument).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      persistedRevision: 1,
      pending: false,
    });
    cleanup();
  });

  it('reports a failed registered Canvas save to the workspace flush result', async () => {
    const persistence = port();
    vi.mocked(persistence.saveDocument).mockRejectedValue(new Error('disk unavailable'));
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
    });
    const cleanup = registerCanvasWorkspaceFlush(controller);
    controller.schedule(documentAt(1));

    await expect(flushCanvasWorkspaceState('tray-hide')).resolves.toEqual({
      completed: 0,
      failed: 1,
      timedOut: false,
    });
    expect(controller.getState()).toMatchObject({
      status: 'sync-error',
      pending: true,
    });
    cleanup();
  });

  it('flushes a debounced edit before asynchronous disposal completes', async () => {
    const persistence = port();
    const controller = createCanvasAutosaveController({
      persistence,
      initialRevision: 0,
      delayMs: 10_000,
    });
    controller.schedule(documentAt(1));

    await controller.dispose();

    expect(persistence.saveDocument).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({
      persistedRevision: 1,
      pending: false,
    });
    controller.schedule(documentAt(2));
    expect(persistence.saveDocument).toHaveBeenCalledOnce();
  });
});
