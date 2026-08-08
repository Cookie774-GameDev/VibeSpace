import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasPage } from './CanvasPage';
import {
  createCanvasBlock,
  createCanvasDocument,
  withBlockAdded,
  withPlacement,
} from './contracts';
import { createCanvasGlobalSearchIndex, requestCanvasGlobalSearchNavigation } from './globalSearch';
import {
  buildActiveCanvasChatAttachments,
  captureActiveCanvasSnapshot,
  clearActiveCanvasAiContextForTests,
  readActiveCanvasAiContext,
} from './aiContextRegistry';
import { CANVAS_MARKDOWN_MAX_SOURCE_LENGTH } from './markdown';
import { createMindMap } from './mindmaps';
import { encodeCanvasPackage } from './packageFormat';
import type { CanvasPersistenceRepository, CanvasPersistenceScope } from './persistence';
import {
  CanvasTemplatePersistenceError,
  type CanvasTemplatePersistenceRepository,
} from './templatePersistence';
import {
  createCustomCanvasTemplateStore,
  saveCanvasDocumentAsTemplate,
  type CustomCanvasTemplateStore,
} from './templates';
import type { CanvasRecoveryEntry } from './autosave';
import { useUIStore } from '@/stores/ui';
import { useWorkbenchStore } from '@/features/workbench/store';

const PERSISTENCE_SCOPE: CanvasPersistenceScope = {
  accountId: 'account-a',
  projectId: 'project-a',
  ownerId: 'account-a',
};

function persistenceRepository(
  overrides: Partial<CanvasPersistenceRepository> = {},
): CanvasPersistenceRepository {
  return {
    save: vi.fn(async (_scope, document) => ({ localRevision: document.localRevision }) as never),
    load: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    loadLatest: vi.fn(async () => undefined),
    writeRecovery: vi.fn(async () => undefined),
    clearRecovery: vi.fn(async () => undefined),
    listRecovery: vi.fn(async () => []),
    listRevisions: vi.fn(async () => []),
    ...overrides,
  };
}

function persistedDocument(scope: CanvasPersistenceScope, id: string, title: string, now = 100) {
  return createCanvasDocument({
    id,
    projectId: scope.projectId,
    ownerId: scope.ownerId,
    title,
    now,
  });
}

function templateRepository(
  overrides: Partial<CanvasTemplatePersistenceRepository> = {},
): CanvasTemplatePersistenceRepository {
  return {
    load: vi.fn(async () => createCustomCanvasTemplateStore()),
    replace: vi.fn(async () => undefined),
    ...overrides,
  };
}

function persistedTemplateStore(
  scope: CanvasPersistenceScope,
  templateId: string,
  title: string,
): CustomCanvasTemplateStore {
  const source = persistedDocument(scope, `${templateId}-source`, title);
  return saveCanvasDocumentAsTemplate(createCustomCanvasTemplateStore(), {
    source,
    templateId,
    ownerId: scope.ownerId,
    projectId: scope.projectId,
    title,
    now: 200,
  }).store;
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Blob read failed')));
    reader.readAsText(blob);
  });
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(new Uint8Array(reader.result as ArrayBuffer)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Blob read failed')));
    reader.readAsArrayBuffer(blob);
  });
}

describe('CanvasPage', () => {
  it('changes the Canvas document wallpaper without changing the Workbench wallpaper', () => {
    const previousWallpaper = useWorkbenchStore.getState().wallpaper;
    act(() => {
      useWorkbenchStore.getState().setWallpaper('aurora');
    });
    const view = render(<CanvasPage />);

    expect(screen.getByTestId('workbench-wallpaper').getAttribute('data-wallpaper')).toBe('none');
    expect(useWorkbenchStore.getState().wallpaper.id).toBe('aurora');
    fireEvent.click(screen.getByRole('button', { name: 'Canvas wallpapers' }));
    expect(screen.getByRole('dialog', { name: 'Interactive wallpapers' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Warm Gradient/i }));
    expect(screen.getByTestId('workbench-wallpaper').getAttribute('data-wallpaper')).toBe(
      'warm-gradient',
    );
    expect(useWorkbenchStore.getState().wallpaper.id).toBe('aurora');
    expect(screen.getByRole('heading', { name: 'Infinite Idea Canvas' })).toBeTruthy();
    view.unmount();
    act(() => {
      useWorkbenchStore.setState({ wallpaper: previousWallpaper });
    });
  });

  it('renders an accessible, truthful local-first Canvas workspace', () => {
    render(<CanvasPage />);

    expect(screen.getByRole('heading', { name: 'Infinite Idea Canvas' })).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Canvas tools' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Canvas workspace' })).toBeTruthy();
    expect(screen.getByText('Local draft')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('does not touch persistence while account identity is unavailable', async () => {
    const repository = persistenceRepository();
    render(<CanvasPage persistence={{ repository, scope: null }} />);

    expect(screen.getByText('Local draft')).toBeTruthy();
    await act(async () => undefined);
    expect(repository.loadLatest).not.toHaveBeenCalled();
    expect(repository.listRecovery).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('hydrates the newest account-scoped document and autosaves the next edit', async () => {
    const latest = persistedDocument(PERSISTENCE_SCOPE, 'persisted-canvas', 'Persisted ideas');
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });
    render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          now: () => 500,
        }}
      />,
    );

    expect(await screen.findByDisplayValue('Persisted ideas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(repository.save).mock.calls[0]?.[0]).toEqual(PERSISTENCE_SCOPE);
    expect(vi.mocked(repository.save).mock.calls[0]?.[1]).toMatchObject({
      id: latest.id,
      projectId: PERSISTENCE_SCOPE.projectId,
      ownerId: PERSISTENCE_SCOPE.ownerId,
    });
    expect(screen.getByText('Saved locally')).toBeTruthy();
  });

  it('publishes exact scoped Canvas and selected-object context only while the route is active', async () => {
    const latest = persistedDocument(PERSISTENCE_SCOPE, 'persisted-canvas', 'Launch canvas');
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });
    clearActiveCanvasAiContextForTests();
    useUIStore.setState({ route: 'canvas' });

    const view = render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          now: () => 500,
        }}
      />,
    );

    expect(await screen.findByDisplayValue('Launch canvas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('article', { name: 'Canvas note' }));

    await waitFor(() =>
      expect(
        readActiveCanvasAiContext({
          accountId: PERSISTENCE_SCOPE.accountId,
          projectId: PERSISTENCE_SCOPE.projectId,
        })?.selection.map(({ id }) => id),
      ).toEqual(['persisted-canvas-note-1']),
    );
    const active = readActiveCanvasAiContext({
      accountId: PERSISTENCE_SCOPE.accountId,
      projectId: PERSISTENCE_SCOPE.projectId,
    });
    expect(
      active?.promptForgeSources.map(({ id, label, reference }) => ({ id, label, reference })),
    ).toEqual([
      {
        id: 'canvas:persisted-canvas',
        label: 'Launch canvas',
        reference: 'canvas:persisted-canvas',
      },
      {
        id: 'canvas-block:persisted-canvas:persisted-canvas-note-1',
        label: 'note block persisted-canvas-note-1',
        reference: 'canvas:persisted-canvas#persisted-canvas-note-1',
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    await waitFor(() =>
      expect(
        buildActiveCanvasChatAttachments(
          {
            accountId: PERSISTENCE_SCOPE.accountId,
            projectId: PERSISTENCE_SCOPE.projectId,
          },
          'frame',
        )[0],
      ).toMatchObject({
        nodeId: 'canvas:persisted-canvas:frame:persisted-canvas-note-1',
        title: 'Presentation frame: note block persisted-canvas-note-1',
      }),
    );
    const snapshot = captureActiveCanvasSnapshot({
      accountId: PERSISTENCE_SCOPE.accountId,
      projectId: PERSISTENCE_SCOPE.projectId,
    });
    expect(snapshot).toMatchObject({
      canvasId: 'persisted-canvas',
      projectId: PERSISTENCE_SCOPE.projectId,
      mimeType: 'image/png',
    });
    expect(snapshot?.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(
      readActiveCanvasAiContext({ accountId: 'account-other', projectId: 'project-a' }),
    ).toBeNull();

    act(() => useUIStore.setState({ route: 'chat' }));
    await waitFor(() =>
      expect(
        readActiveCanvasAiContext({
          accountId: PERSISTENCE_SCOPE.accountId,
          projectId: PERSISTENCE_SCOPE.projectId,
        }),
      ).toBeNull(),
    );
    view.unmount();
    clearActiveCanvasAiContextForTests();
  });

  it('loads a staged global-search document and applies its object camera', async () => {
    const base = persistedDocument(PERSISTENCE_SCOPE, 'searched-canvas', 'Search destination');
    const withText = withBlockAdded(
      base,
      createCanvasBlock({
        id: 'searched-note',
        content: { kind: 'text', text: 'Zoom destination' },
        now: base.updatedAt,
      }),
      base.updatedAt,
    );
    const target = withPlacement(
      withText,
      {
        blockId: 'searched-note',
        x: 700,
        y: 450,
        width: 300,
        height: 120,
      },
      withText.updatedAt,
    );
    const [result] = createCanvasGlobalSearchIndex({
      ownerId: PERSISTENCE_SCOPE.ownerId,
      projectId: PERSISTENCE_SCOPE.projectId,
      documents: [target],
    }).query({ text: 'destination' });
    const selection = requestCanvasGlobalSearchNavigation(
      result,
      {
        ownerId: PERSISTENCE_SCOPE.ownerId,
        projectId: PERSISTENCE_SCOPE.projectId,
      },
      { width: 1_200, height: 800 },
    );
    const repository = persistenceRepository({
      load: vi.fn(async (_scope, documentId) => (documentId === target.id ? target : undefined)),
    });

    render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          now: () => 500,
        }}
      />,
    );

    expect(await screen.findByDisplayValue('Search destination')).toBeTruthy();
    expect(repository.load).toHaveBeenCalledWith(PERSISTENCE_SCOPE, target.id);
    expect(repository.loadLatest).not.toHaveBeenCalled();
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    expect(workspace.dataset.cameraX).toBe(String(selection.camera.x));
    expect(workspace.dataset.cameraY).toBe(String(selection.camera.y));
    expect(workspace.dataset.cameraZoom).toBe(String(selection.camera.zoom));
  });

  it('falls back to the latest scoped canvas when a staged search result is stale', async () => {
    const stale = persistedDocument(
      PERSISTENCE_SCOPE,
      'stale-search-canvas',
      'Stale search canvas',
    );
    const [result] = createCanvasGlobalSearchIndex({
      ownerId: PERSISTENCE_SCOPE.ownerId,
      projectId: PERSISTENCE_SCOPE.projectId,
      documents: [stale],
    }).query({ objectType: 'document' });
    requestCanvasGlobalSearchNavigation(
      result,
      {
        ownerId: PERSISTENCE_SCOPE.ownerId,
        projectId: PERSISTENCE_SCOPE.projectId,
      },
      { width: 1_200, height: 800 },
    );
    const latest = persistedDocument(
      PERSISTENCE_SCOPE,
      'latest-after-stale-search',
      'Latest safe canvas',
    );
    const repository = persistenceRepository({
      load: vi.fn(async () => undefined),
      loadLatest: vi.fn(async () => latest),
    });

    render(<CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />);

    expect(await screen.findByDisplayValue('Latest safe canvas')).toBeTruthy();
    expect(repository.loadLatest).toHaveBeenCalledWith(PERSISTENCE_SCOPE);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('switches an already-mounted canvas to a newly selected global-search result', async () => {
    const initial = persistedDocument(PERSISTENCE_SCOPE, 'initial-canvas', 'Initial canvas');
    const base = persistedDocument(PERSISTENCE_SCOPE, 'next-canvas', 'Next canvas');
    const withText = withBlockAdded(
      base,
      createCanvasBlock({
        id: 'next-note',
        content: { kind: 'text', text: 'Find the next object' },
        now: base.updatedAt,
      }),
      base.updatedAt,
    );
    const target = withPlacement(
      withText,
      { blockId: 'next-note', x: 900, y: 500, width: 240, height: 120 },
      withText.updatedAt,
    );
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => initial),
      load: vi.fn(async (_scope, documentId) => (documentId === target.id ? target : undefined)),
    });
    render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          now: () => 500,
        }}
      />,
    );
    expect(await screen.findByDisplayValue('Initial canvas')).toBeTruthy();
    const [result] = createCanvasGlobalSearchIndex({
      ownerId: PERSISTENCE_SCOPE.ownerId,
      projectId: PERSISTENCE_SCOPE.projectId,
      documents: [target],
    }).query({ text: 'next object' });

    await act(async () => {
      requestCanvasGlobalSearchNavigation(
        result,
        {
          ownerId: PERSISTENCE_SCOPE.ownerId,
          projectId: PERSISTENCE_SCOPE.projectId,
        },
        { width: 1_200, height: 800 },
      );
    });

    expect(await screen.findByDisplayValue('Next canvas')).toBeTruthy();
    expect(repository.load).toHaveBeenCalledWith(PERSISTENCE_SCOPE, target.id);
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
  });

  it('ignores a stale account load after the persistence scope changes', async () => {
    let resolveFirst: ((value: ReturnType<typeof persistedDocument>) => void) | undefined;
    const firstLoad = new Promise<ReturnType<typeof persistedDocument>>((resolve) => {
      resolveFirst = resolve;
    });
    const scopeB = {
      accountId: 'account-b',
      projectId: 'project-b',
      ownerId: 'account-b',
    };
    const repository = persistenceRepository({
      loadLatest: vi.fn(async (scope) =>
        scope.accountId === PERSISTENCE_SCOPE.accountId
          ? firstLoad
          : persistedDocument(scopeB, 'canvas-b', 'Account B canvas', 200),
      ),
    });
    const { rerender } = render(
      <CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />,
    );

    rerender(<CanvasPage persistence={{ repository, scope: scopeB }} />);
    expect(await screen.findByDisplayValue('Account B canvas')).toBeTruthy();
    resolveFirst?.(persistedDocument(PERSISTENCE_SCOPE, 'canvas-a', 'Stale account A', 100));
    await act(async () => {
      await firstLoad;
    });

    expect(screen.queryByDisplayValue('Stale account A')).toBeNull();
    expect(screen.getByDisplayValue('Account B canvas')).toBeTruthy();
  });

  it('offers validated recovery and restores it into autosave', async () => {
    const recovered = persistedDocument(
      PERSISTENCE_SCOPE,
      'recovered-canvas',
      'Recovered ideas',
      300,
    );
    const entry: CanvasRecoveryEntry = {
      schemaVersion: 1,
      id: 'recovery-1',
      documentId: recovered.id,
      projectId: recovered.projectId,
      ownerId: recovered.ownerId,
      baseRevision: 0,
      createdAt: 301,
      document: recovered,
    };
    const repository = persistenceRepository({
      listRecovery: vi.fn(async () => [entry]),
    });
    render(
      <CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE, autosaveDelayMs: 0 }} />,
    );

    expect(await screen.findByText('Unsaved canvas recovery is available.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovered canvas' }));

    expect(await screen.findByDisplayValue('Recovered ideas')).toBeTruthy();
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
  });

  it('discards a recovery entry without applying its document', async () => {
    const recovered = persistedDocument(
      PERSISTENCE_SCOPE,
      'discarded-canvas',
      'Should not appear',
      300,
    );
    const entry: CanvasRecoveryEntry = {
      schemaVersion: 1,
      id: 'recovery-discard',
      documentId: recovered.id,
      projectId: recovered.projectId,
      ownerId: recovered.ownerId,
      baseRevision: 0,
      createdAt: 301,
      document: recovered,
    };
    const repository = persistenceRepository({
      listRecovery: vi.fn(async () => [entry]),
    });
    render(<CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Discard recovered canvas' }));
    await waitFor(() =>
      expect(repository.clearRecovery).toHaveBeenCalledWith(PERSISTENCE_SCOPE, entry.id),
    );
    expect(screen.queryByDisplayValue('Should not appear')).toBeNull();
  });

  it('flushes the newest debounced edit when the Canvas unmounts', async () => {
    const latest = persistedDocument(PERSISTENCE_SCOPE, 'flush-canvas', 'Flush me');
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });
    const { unmount } = render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 60_000,
        }}
      />,
    );

    expect(await screen.findByDisplayValue('Flush me')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(repository.save).not.toHaveBeenCalled();
    unmount();

    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
  });

  it('adds one canonical content block and undoes and redoes the transaction', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByDisplayValue('New note 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('creates a new real canvas from a built-in template', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByText('Templates'));

    const builtIn = screen.getByRole('combobox', { name: 'Built-in canvas template' });
    fireEvent.change(builtIn, { target: { value: 'project-planner' } });
    expect(screen.getByRole('region', { name: 'Built-in template preview' }).textContent).toContain(
      'Project planner',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas from Project planner' }));

    expect(confirm).toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value).toBe(
      'Project planner',
    );
    expect(screen.queryByDisplayValue('New note 1')).toBeNull();
    expect(screen.getAllByLabelText(/Canvas (heading|note)/).length).toBeGreaterThan(0);
    expect(screen.getByText('Created a new canvas from Project planner')).toBeTruthy();
    confirm.mockRestore();
  });

  it('autosaves a template-created canvas through the active scoped repository', async () => {
    const latest = persistedDocument(PERSISTENCE_SCOPE, 'template-source', 'Template source');
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          createDocumentId: () => 'template-created-canvas',
        }}
      />,
    );
    expect(await screen.findByDisplayValue('Template source')).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas from Blank canvas' }));

    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(repository.save).mock.calls[0]?.[0]).toEqual(PERSISTENCE_SCOPE);
    expect(vi.mocked(repository.save).mock.calls[0]?.[1]).toMatchObject({
      id: 'template-created-canvas',
      projectId: PERSISTENCE_SCOPE.projectId,
      ownerId: PERSISTENCE_SCOPE.ownerId,
      title: 'Blank canvas',
    });
    confirm.mockRestore();
  });

  it('manages the scoped custom-template lifecycle with real canvas snapshots', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByText('Templates'));

    fireEvent.change(screen.getByRole('textbox', { name: 'Custom template name' }), {
      target: { value: 'Team board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save current canvas as template' }));

    const customTemplates = screen.getByRole('list', { name: 'Custom canvas templates' });
    expect(within(customTemplates).getByText('Team board')).toBeTruthy();
    fireEvent.click(
      within(customTemplates).getByRole('button', { name: 'Preview template Team board' }),
    );
    expect(
      screen.getByRole('region', { name: 'Template preview Team board' }).textContent,
    ).toContain('New note 1');

    fireEvent.click(
      within(customTemplates).getByRole('button', { name: 'Duplicate template Team board' }),
    );
    expect(within(customTemplates).getByText('Team board copy')).toBeTruthy();

    const rename = within(customTemplates).getByRole('textbox', {
      name: 'Rename template Team board',
    });
    fireEvent.change(rename, { target: { value: 'Reusable team board' } });
    fireEvent.click(
      within(customTemplates).getByRole('button', { name: 'Apply template name Team board' }),
    );
    expect(within(customTemplates).getByText('Reusable team board')).toBeTruthy();

    fireEvent.click(
      within(customTemplates).getByRole('button', {
        name: 'Create canvas from Reusable team board',
      }),
    );
    expect((screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value).toBe(
      'Reusable team board',
    );
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();

    fireEvent.click(
      within(customTemplates).getByRole('button', {
        name: 'Delete template Reusable team board',
      }),
    );
    expect(confirm).toHaveBeenCalled();
    expect(within(customTemplates).queryByText('Reusable team board')).toBeNull();
    expect(within(customTemplates).getByText('Team board copy')).toBeTruthy();
    confirm.mockRestore();
  });

  it('reloads durable custom templates after the Canvas remounts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let durableStore = createCustomCanvasTemplateStore();
    const templates = templateRepository({
      load: vi.fn(async () => durableStore),
      replace: vi.fn(async (_scope, store) => {
        durableStore = store;
      }),
    });
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () =>
        persistedDocument(PERSISTENCE_SCOPE, 'durable-source', 'Durable source'),
      ),
    });
    const binding = {
      repository,
      templateRepository: templates,
      scope: PERSISTENCE_SCOPE,
    };
    const first = render(<CanvasPage persistence={binding} />);
    expect(await screen.findByDisplayValue('Durable source')).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom template name' }), {
      target: { value: 'Restart-safe board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save current canvas as template' }));
    await waitFor(() => expect(templates.replace).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Restart-safe board')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate template Restart-safe board' }));
    await waitFor(() => expect(templates.replace).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Restart-safe board copy')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename template Restart-safe board' }), {
      target: { value: 'Durable renamed board' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply template name Restart-safe board' }));
    await waitFor(() => expect(templates.replace).toHaveBeenCalledTimes(3));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete template Durable renamed board' }),
    );
    await waitFor(() => expect(templates.replace).toHaveBeenCalledTimes(4));
    expect(screen.queryByText('Durable renamed board')).toBeNull();
    first.unmount();

    render(<CanvasPage persistence={binding} />);
    expect(await screen.findByDisplayValue('Durable source')).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    expect(await screen.findByText('Restart-safe board copy')).toBeTruthy();
    expect(screen.queryByText('Durable renamed board')).toBeNull();
    expect(templates.load).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it('suppresses a stale template load after the account and project scope switch', async () => {
    let resolveAccountA!: (store: CustomCanvasTemplateStore) => void;
    const accountALoad = new Promise<CustomCanvasTemplateStore>((resolve) => {
      resolveAccountA = resolve;
    });
    const scopeB: CanvasPersistenceScope = {
      accountId: 'account-b',
      ownerId: 'account-b',
      projectId: 'project-b',
    };
    const templates = templateRepository({
      load: vi.fn(async (scope) =>
        scope.accountId === PERSISTENCE_SCOPE.accountId
          ? accountALoad
          : persistedTemplateStore(scopeB, 'template-b', 'Account B template'),
      ),
    });
    const repository = persistenceRepository({
      loadLatest: vi.fn(async (scope) =>
        persistedDocument(scope, `canvas-${scope.accountId}`, `Canvas ${scope.accountId}`),
      ),
    });
    const { rerender } = render(
      <CanvasPage
        persistence={{
          repository,
          templateRepository: templates,
          scope: PERSISTENCE_SCOPE,
        }}
      />,
    );
    rerender(
      <CanvasPage persistence={{ repository, templateRepository: templates, scope: scopeB }} />,
    );
    expect(await screen.findByDisplayValue('Canvas account-b')).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    expect(await screen.findByText('Account B template')).toBeTruthy();

    resolveAccountA(
      persistedTemplateStore(PERSISTENCE_SCOPE, 'template-a', 'Stale account A template'),
    );
    await act(async () => {
      await accountALoad;
    });
    expect(screen.queryByText('Stale account A template')).toBeNull();
    expect(screen.getByText('Account B template')).toBeTruthy();
  });

  it('keeps the prior durable store when a bounded template save fails', async () => {
    const templates = templateRepository({
      replace: vi.fn(async () => {
        throw new CanvasTemplatePersistenceError(
          'storage-failure',
          'Templates could not be saved locally.',
        );
      }),
    });
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () =>
        persistedDocument(PERSISTENCE_SCOPE, 'failed-save-source', 'Failed save source'),
      ),
    });
    render(
      <CanvasPage
        persistence={{
          repository,
          templateRepository: templates,
          scope: PERSISTENCE_SCOPE,
        }}
      />,
    );
    expect(await screen.findByDisplayValue('Failed save source')).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom template name' }), {
      target: { value: 'Must not appear' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save current canvas as template' }));

    expect(
      await screen.findByText('Save template failed: Templates could not be saved locally.'),
    ).toBeTruthy();
    expect(screen.queryByText('Must not appear')).toBeNull();
  });

  it('surfaces a bounded template load error without exposing persisted row data', async () => {
    const templates = templateRepository({
      load: vi.fn(async () => {
        throw new CanvasTemplatePersistenceError(
          'invalid-data',
          'Saved templates could not be loaded safely.',
        );
      }),
    });
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () =>
        persistedDocument(PERSISTENCE_SCOPE, 'failed-load-source', 'Failed load source'),
      ),
    });
    render(
      <CanvasPage
        persistence={{
          repository,
          templateRepository: templates,
          scope: PERSISTENCE_SCOPE,
        }}
      />,
    );

    expect(
      await screen.findByText('Load templates failed: Saved templates could not be loaded safely.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Templates'));
    expect(screen.getByText('No custom templates yet.')).toBeTruthy();
    expect(screen.queryByText('Secret malformed template')).toBeNull();
  });

  it('switches the same content between page and edgeless layouts', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));

    expect(
      screen.getByRole('button', { name: 'Edgeless layout' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Canvas workspace' }).dataset.layout).toBe(
      'edgeless',
    );
  });

  it('renders the persisted Canvas background through generated pattern styles', async () => {
    const latest = createCanvasDocument({
      id: 'surface-canvas',
      projectId: PERSISTENCE_SCOPE.projectId,
      ownerId: PERSISTENCE_SCOPE.ownerId,
      title: 'Surface study',
      background: { kind: 'dots', color: '#f4eddf' },
      now: 100,
    });
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });

    render(<CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />);

    expect(await screen.findByDisplayValue('Surface study')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    expect(
      (screen.getByRole('combobox', { name: 'Canvas background pattern' }) as HTMLSelectElement)
        .value,
    ).toBe('dots');
    expect((screen.getByLabelText('Canvas background color') as HTMLInputElement).value).toBe(
      '#f4eddf',
    );
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    expect(workspace.dataset.backgroundKind).toBe('dots');
    expect(workspace.style.backgroundImage).toContain('radial-gradient');
  });

  it('commits a Canvas background change as one undoable autosaved edit', async () => {
    const latest = persistedDocument(PERSISTENCE_SCOPE, 'background-canvas', 'Background canvas');
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => latest),
    });
    render(
      <CanvasPage
        persistence={{
          repository,
          scope: PERSISTENCE_SCOPE,
          autosaveDelayMs: 0,
          now: () => 500,
        }}
      />,
    );

    expect(await screen.findByDisplayValue('Background canvas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas background pattern' }), {
      target: { value: 'grid' },
    });

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    expect(workspace.dataset.backgroundKind).toBe('grid');
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(repository.save).mock.calls[0]?.[1].background).toEqual({
      kind: 'grid',
      color: '#ffffff',
      wallpaper: {
        id: 'none',
        paused: false,
        interactive: true,
        intensity: 0.72,
        brightness: 0.5,
        quality: 'balanced',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(workspace.dataset.backgroundKind).toBe('plain');
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(workspace.dataset.backgroundKind).toBe('grid');
    await waitFor(() => expect(repository.save).toHaveBeenCalledTimes(3));
    const savedRevisions = vi
      .mocked(repository.save)
      .mock.calls.map((call) => call[1].localRevision);
    expect(savedRevisions).toEqual([1, 2, 3]);
  });

  it('supports keyboard undo and redo without hijacking editable targets', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.queryByDisplayValue('New note 1')).toBeNull();

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();

    const title = screen.getByRole('textbox', { name: 'Canvas title' });
    fireEvent.keyDown(title, { key: 'z', ctrlKey: true });
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('commits each user action once when React replays state updaters in StrictMode', () => {
    render(
      <React.StrictMode>
        <CanvasPage />
      </React.StrictMode>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.queryByDisplayValue('New note 1')).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('pans with the hand tool and zooms around the pointer wheel position', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hand tool' }));

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerDown(workspace, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(workspace, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(workspace, { pointerId: 1, clientX: 140, clientY: 120 });

    expect(workspace.dataset.cameraX).toBe('-40');
    expect(workspace.dataset.cameraY).toBe('-20');

    fireEvent.wheel(workspace, { deltaY: -100, clientX: 600, clientY: 400 });
    expect(screen.getByText('111%')).toBeTruthy();
  });

  it('offers an accessible minimap and returns to the previous meaningful location', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hand tool' }));

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerDown(workspace, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(workspace, { pointerId: 1, clientX: 140, clientY: 120 });
    fireEvent.pointerUp(workspace, { pointerId: 1, clientX: 140, clientY: 120 });

    expect(screen.getByRole('region', { name: 'Canvas minimap' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Focus .*note-1 from minimap/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(workspace.dataset.cameraX).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Back to previous canvas location' }));
    expect(workspace.dataset.cameraX).toBe('-40');
    expect(workspace.dataset.cameraY).toBe('-20');
  });

  it('supports two-pointer pinch zoom in edgeless mode', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });

    fireEvent.pointerDown(workspace, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerDown(workspace, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerMove(workspace, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 300,
      clientY: 100,
    });

    expect(screen.getByText('200%')).toBeTruthy();
  });

  it('supports click, additive, select-all, and delete selection without pointer-only controls', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    const notes = screen.getAllByLabelText('Canvas note');

    fireEvent.click(notes[0]);
    fireEvent.click(notes[1], { shiftKey: true });
    expect(notes[0].dataset.selected).toBe('true');
    expect(notes[1].dataset.selected).toBe('true');
    expect(screen.getByText('2 canvas objects selected')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.queryAllByLabelText('Canvas note')).toHaveLength(0);
  });

  it('selects objects enclosed by the accessible edgeless lasso tool', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lasso tool' }));

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerDown(workspace, { pointerId: 10, button: 0, clientX: 580, clientY: 380 });
    fireEvent.pointerMove(workspace, { pointerId: 10, clientX: 900, clientY: 380 });
    fireEvent.pointerMove(workspace, { pointerId: 10, clientX: 900, clientY: 620 });
    fireEvent.pointerMove(workspace, { pointerId: 10, clientX: 580, clientY: 620 });
    fireEvent.pointerUp(workspace, { pointerId: 10, clientX: 580, clientY: 380 });

    const notes = screen.getAllByLabelText('Canvas note');
    expect(notes[0].dataset.selected).toBe('true');
    expect(notes[1].dataset.selected).toBe('false');
  });

  it('describes canvas objects, announces zoom, and clears selection with Escape', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    const note = screen.getByLabelText('Canvas note');
    expect(note.getAttribute('aria-description')).toBe('Note: New note 1');

    fireEvent.click(note);
    expect(note.dataset.selected).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(note.dataset.selected).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('status', { name: 'Canvas zoom announcement' }).textContent).toBe(
      'Canvas zoom 125 percent',
    );
  });

  it('nudges selected edgeless objects with fine and coarse keyboard movement', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');
    fireEvent.click(note);
    const before = Number.parseFloat(note.style.left);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowDown', shiftKey: true });

    expect(Number.parseFloat(note.style.left)).toBe(before + 1);
    expect(Number.parseFloat(note.style.top)).toBe(10);
  });

  it('keeps locked edgeless objects selectable but prevents mutation until unlocked', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');
    fireEvent.click(note);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    const before = Number.parseFloat(note.style.left);

    fireEvent.click(screen.getByRole('button', { name: 'Lock selected object' }));

    expect((screen.getByLabelText('Selected block text') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('Selected object X') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Delete selected object' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.pointerDown(note, { pointerId: 31, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(note, { pointerId: 31, clientX: 650, clientY: 400 });
    fireEvent.pointerUp(note, { pointerId: 31, clientX: 650, clientY: 400 });
    expect(Number.parseFloat(note.style.left)).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Unlock selected object' }));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(Number.parseFloat(note.style.left)).toBe(before + 1);
  });

  it('hides an edgeless object without deleting it and restores visibility through undo', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));

    fireEvent.click(screen.getByRole('button', { name: 'Hide selected object' }));

    expect(screen.queryByLabelText('Canvas note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show selected object' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show canvas outline' }));
    expect(screen.getByRole('treeitem', { name: 'Note: New note 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Canvas note')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    expect(screen.getByRole('button', { name: 'Hide selected object' })).toBeTruthy();
  });

  it('aligns and distributes selected edgeless objects through undoable controls', async () => {
    let canvas = createCanvasDocument({
      id: 'geometry-canvas',
      projectId: PERSISTENCE_SCOPE.projectId,
      ownerId: PERSISTENCE_SCOPE.ownerId,
      layoutMode: 'edgeless',
      now: 100,
    });
    for (const [index, x, y] of [
      [1, 0, 0],
      [2, 220, 70],
      [3, 480, 140],
    ] as const) {
      const block = createCanvasBlock({
        id: `geometry-note-${index}`,
        content: { kind: 'note', text: `Geometry note ${index}` },
        now: 100,
      });
      canvas = withPlacement(
        withBlockAdded(canvas, block, 100),
        { blockId: block.id, x, y, width: 160, height: 100 },
        100,
      );
    }
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => canvas),
    });
    render(<CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />);

    expect(await screen.findByDisplayValue('Geometry note 1')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Align selected objects to top' }));

    const notes = screen.getAllByLabelText('Canvas note');
    expect(notes.map((note) => Number.parseFloat(note.style.top))).toEqual([0, 0, 0]);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(notes.map((note) => Number.parseFloat(note.style.top))).toEqual([0, 70, 140]);

    fireEvent.click(
      screen.getByRole('button', { name: 'Distribute selected objects horizontally' }),
    );
    expect(notes.map((note) => Number.parseFloat(note.style.left))).toEqual([0, 240, 480]);
  });

  it('moves a selected edgeless object through the persisted z-order', async () => {
    let canvas = createCanvasDocument({
      id: 'z-order-canvas',
      projectId: PERSISTENCE_SCOPE.projectId,
      ownerId: PERSISTENCE_SCOPE.ownerId,
      layoutMode: 'edgeless',
      now: 100,
    });
    for (const [index, z] of [
      [1, 0],
      [2, 1],
    ] as const) {
      const block = createCanvasBlock({
        id: `z-note-${index}`,
        content: { kind: 'note', text: `Z note ${index}` },
        now: 100,
      });
      canvas = withPlacement(
        withBlockAdded(canvas, block, 100),
        { blockId: block.id, x: index * 40, y: index * 40, width: 200, height: 120, z },
        100,
      );
    }
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => canvas),
    });
    render(<CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />);

    expect(await screen.findByDisplayValue('Z note 1')).toBeTruthy();
    const notes = screen.getAllByLabelText('Canvas note');
    fireEvent.click(notes[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bring selected object to front' }));

    expect(Number.parseInt(notes[0].style.zIndex, 10)).toBeGreaterThan(
      Number.parseInt(notes[1].style.zIndex, 10),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Number.parseInt(notes[0].style.zIndex, 10)).toBeLessThan(
      Number.parseInt(notes[1].style.zIndex, 10),
    );
  });

  it('persists precise position, size, and rotation edits as undoable transforms', async () => {
    const block = createCanvasBlock({
      id: 'transform-note',
      content: { kind: 'note', text: 'Transform me' },
      now: 100,
    });
    const canvas = withPlacement(
      withBlockAdded(
        createCanvasDocument({
          id: 'transform-canvas',
          projectId: PERSISTENCE_SCOPE.projectId,
          ownerId: PERSISTENCE_SCOPE.ownerId,
          layoutMode: 'edgeless',
          now: 100,
        }),
        block,
        100,
      ),
      { blockId: block.id, x: 40, y: 60, width: 200, height: 120, rotation: 0 },
      100,
    );
    const repository = persistenceRepository({
      loadLatest: vi.fn(async () => canvas),
    });
    render(
      <CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE, autosaveDelayMs: 0 }} />,
    );

    expect(await screen.findByDisplayValue('Transform me')).toBeTruthy();
    const note = screen.getByLabelText('Canvas note');
    fireEvent.click(note);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Selected object X' }), {
      target: { value: '125' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Selected object width' }), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Selected object rotation' }), {
      target: { value: '45' },
    });

    expect(Number.parseFloat(note.style.left)).toBe(125);
    expect(Number.parseFloat(note.style.width)).toBe(16);
    expect(note.style.transform).toBe('rotate(45deg)');
    await waitFor(() => expect(repository.save).toHaveBeenCalled());
    expect(vi.mocked(repository.save).mock.calls.at(-1)?.[1].placements[0]).toMatchObject({
      blockId: block.id,
      x: 125,
      width: 16,
      rotation: 45,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(note.style.transform).toBe('rotate(0deg)');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Number.parseFloat(note.style.width)).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Number.parseFloat(note.style.left)).toBe(40);
  });

  it('drags selected objects in world coordinates as one undoable action', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');
    const beforeLeft = Number.parseFloat(note.style.left);
    const beforeTop = Number.parseFloat(note.style.top);

    fireEvent.pointerDown(note, { pointerId: 3, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(note, { pointerId: 3, clientX: 630, clientY: 420 });
    expect(Number.parseFloat(note.style.left)).toBe(beforeLeft);
    expect(note.style.transform).toContain('translate');
    fireEvent.pointerUp(note, { pointerId: 3, clientX: 630, clientY: 420 });

    expect(Number.parseFloat(note.style.left)).toBe(beforeLeft + 30);
    expect(Number.parseFloat(note.style.top)).toBe(beforeTop + 20);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Number.parseFloat(note.style.left)).toBe(beforeLeft);
    expect(Number.parseFloat(note.style.top)).toBe(beforeTop);
  });

  it('resizes a selected object from a direct handle as one undoable action', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');
    fireEvent.click(note);
    const handle = screen.getByRole('button', { name: 'Resize selected object from southeast' });

    fireEvent.pointerDown(handle, { pointerId: 51, button: 0, clientX: 880, clientY: 580 });
    fireEvent.pointerMove(handle, { pointerId: 51, clientX: 930, clientY: 610 });
    expect(note.style.width).toBe('330px');
    expect(note.style.height).toBe('210px');
    fireEvent.pointerUp(handle, { pointerId: 51, clientX: 930, clientY: 610 });

    expect(Number.parseFloat(note.style.width)).toBe(330);
    expect(Number.parseFloat(note.style.height)).toBe(210);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(Number.parseFloat(note.style.width)).toBe(280);
    expect(Number.parseFloat(note.style.height)).toBe(180);

    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Resize selected object from southeast' }),
      { key: 'ArrowRight' },
    );
    expect(Number.parseFloat(note.style.width)).toBe(281);
  });

  it('rotates a selected object from a direct handle as one undoable action', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');
    fireEvent.click(note);
    const handle = screen.getByRole('button', { name: 'Rotate selected object' });

    fireEvent.pointerDown(handle, { pointerId: 52, button: 0, clientX: 740, clientY: 390 });
    fireEvent.pointerMove(handle, { pointerId: 52, clientX: 840, clientY: 490 });
    fireEvent.pointerUp(handle, { pointerId: 52, clientX: 840, clientY: 490 });

    expect(note.style.transform).toBe('rotate(90deg)');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(note.style.transform).toBe('rotate(0deg)');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Rotate selected object' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(note.style.transform).toBe('rotate(15deg)');
  });

  it('snaps dragged objects to nearby anchors and shows transient smart guides', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const notes = screen.getAllByLabelText('Canvas note');

    expect(
      (screen.getByRole('button', { name: 'Object snapping' }) as HTMLButtonElement).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    fireEvent.pointerDown(notes[0], { pointerId: 41, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(notes[0], { pointerId: 41, clientX: 645, clientY: 400 });

    expect(notes[0].style.transform).toContain('translate(48px, 0px)');
    expect(document.querySelector('[data-smart-guide-axis="x"]')).toBeTruthy();

    fireEvent.pointerUp(notes[0], { pointerId: 41, clientX: 645, clientY: 400 });
    expect(Number.parseFloat(notes[0].style.left)).toBe(48);
    expect(document.querySelector('[data-smart-guide-axis="x"]')).toBeNull();
  });

  it('offers optional world-grid snapping without requiring an object target', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');

    const gridSnapping = screen.getByRole('button', { name: 'Grid snapping' });
    expect(gridSnapping.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(gridSnapping);
    expect(gridSnapping.getAttribute('aria-pressed')).toBe('true');

    fireEvent.pointerDown(note, { pointerId: 42, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(note, { pointerId: 42, clientX: 614, clientY: 414 });
    fireEvent.pointerUp(note, { pointerId: 42, clientX: 614, clientY: 414 });

    expect(Number.parseFloat(note.style.left)).toBe(24);
    expect(Number.parseFloat(note.style.top)).toBe(24);
  });

  it('culls distant edgeless objects and reveals them after fitting the camera', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const note = screen.getByLabelText('Canvas note');

    fireEvent.pointerDown(note, { pointerId: 4, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(note, { pointerId: 4, clientX: 5600, clientY: 5400 });
    fireEvent.pointerUp(note, { pointerId: 4, clientX: 5600, clientY: 5400 });

    expect(screen.queryByDisplayValue('New note 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fit content' }));
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('marquee-selects intersecting objects in edgeless world space', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });

    fireEvent.pointerDown(workspace, {
      pointerId: 7,
      button: 0,
      clientX: 590,
      clientY: 390,
    });
    fireEvent.pointerMove(workspace, { pointerId: 7, clientX: 890, clientY: 600 });
    expect(workspace.querySelector('[data-selection-marquee]')).toBeTruthy();
    fireEvent.pointerUp(workspace, { pointerId: 7, clientX: 890, clientY: 600 });

    const notes = screen.getAllByLabelText('Canvas note');
    expect(notes[0].dataset.selected).toBe('true');
    expect(notes[1].dataset.selected).toBe('false');
  });

  it('opens the accessible outline and activates its canonical canvas object', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas outline' }));

    const outline = screen.getByRole('navigation', { name: 'Canvas object outline' });
    expect(outline).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: 'Note: New note 1' }));

    expect(screen.getByLabelText('Canvas note').dataset.selected).toBe('true');
  });

  it('searches the current canvas by text, object type, and presentation frame, then focuses it', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add heading' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByLabelText('Search current canvas'));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Canvas search text' }), {
      target: { value: 'New note 1' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas search object type' }), {
      target: { value: 'note' },
    });
    const frameFilter = screen.getByRole('combobox', {
      name: 'Canvas search presentation frame',
    }) as HTMLSelectElement;
    const noteFrame = [...frameFilter.options].find((option) => option.text === 'New note 1');
    expect(noteFrame).toBeTruthy();
    fireEvent.change(frameFilter, { target: { value: noteFrame!.value } });

    const result = screen.getByRole('button', { name: 'Focus search result New note 1' });
    expect(screen.getByLabelText('Current zoom').textContent).toBe('100%');
    fireEvent.click(result);
    expect(screen.getByLabelText('Current zoom').textContent).not.toBe('100%');
    expect(screen.getByLabelText('Canvas note').dataset.selected).toBe('true');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Canvas search text' }), {
      target: { value: 'definitely missing' },
    });
    expect(screen.getByText('No matching canvas objects.')).toBeTruthy();
  });

  it('offers a collapsible context-sensitive properties panel for the selected object', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add heading' }));
    fireEvent.click(screen.getByLabelText('Canvas heading'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));

    const panel = screen.getByRole('region', { name: 'Canvas properties panel' });
    expect(panel).toBeTruthy();
    expect(screen.getByText('Heading properties')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Selected block text' }), {
      target: { value: 'A better heading' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Heading level' }), {
      target: { value: '3' },
    });

    expect(
      (screen.getByRole('textbox', { name: 'Edit heading block' }) as HTMLTextAreaElement).value,
    ).toBe('A better heading');
    expect(
      (screen.getByRole('combobox', { name: 'Heading level' }) as HTMLSelectElement).value,
    ).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: 'Hide canvas properties' }));
    expect(screen.queryByRole('region', { name: 'Canvas properties panel' })).toBeNull();
  });

  it('creates, edits, searches, and renders a real persisted shape in both layouts', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add shape' }));
    expect(screen.getByLabelText('Canvas shape: Rectangle shape: New shape 1')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Canvas shape'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape kind' }), {
      target: { value: 'diamond' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Shape label' }), {
      target: { value: 'Architecture decision' },
    });
    fireEvent.change(screen.getByLabelText('Shape fill color'), {
      target: { value: '#2f80ed' },
    });

    const shape = screen.getByLabelText('Canvas shape: Diamond shape: Architecture decision');
    expect(shape.getAttribute('data-shape-kind')).toBe('diamond');
    expect(shape.getAttribute('data-shape-fill')).toBe('#2f80ed');

    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    expect(
      screen.getByLabelText('Canvas shape: Diamond shape: Architecture decision'),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Search current canvas'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Canvas search text' }), {
      target: { value: 'architecture decision' },
    });
    expect(
      screen.getByRole('button', { name: 'Focus search result Architecture decision' }),
    ).toBeTruthy();
  });

  it('reports the current tool and summarizes multi-selection properties', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Hand tool' }));
    expect(screen.getByRole('status', { name: 'Current canvas tool' }).textContent).toBe('Hand');

    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    const notes = screen.getAllByLabelText('Canvas note');
    fireEvent.click(notes[0]);
    fireEvent.click(notes[1], { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));

    expect(screen.getByText('2 objects selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected objects' }));
    expect(screen.queryAllByLabelText('Canvas note')).toHaveLength(0);
  });

  it('adds selected objects to a real presentation order and presents them', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));

    expect(screen.getByRole('status', { name: 'Presentation frame count' }).textContent).toBe(
      '1 slide',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Present canvas' }));

    const presentation = screen.getByRole('region', { name: 'Canvas presentation' });
    expect(presentation).toBeTruthy();
    expect(window.document.activeElement).toBe(presentation);
    expect(within(presentation).getByText('New note 1')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Presentation progress' }).textContent).toBe(
      'Slide 1 of 1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Exit presentation' }));
    expect(screen.queryByRole('region', { name: 'Canvas presentation' })).toBeNull();
    expect(window.document.activeElement).toBe(
      screen.getByRole('button', { name: 'Present canvas' }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove selected object from presentation' }),
    );
    expect(screen.getByRole('status', { name: 'Presentation frame count' }).textContent).toBe(
      '0 slides',
    );
    expect(
      (screen.getByRole('button', { name: 'Present canvas' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reorders persisted presentation frames accessibly as one undoable action', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(addNote);
    fireEvent.click(screen.getAllByLabelText('Canvas note')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByText('Presentation order'));

    const frameItems = () =>
      within(screen.getByRole('list', { name: 'Canvas presentation order' })).getAllByRole(
        'listitem',
      );
    const frameNames = () => frameItems().map((item) => item.getAttribute('aria-label'));

    expect(frameNames()).toEqual([
      'Presentation frame 1: New note 1',
      'Presentation frame 2: New note 2',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Move New note 2 earlier' }));
    expect(frameNames()).toEqual([
      'Presentation frame 1: New note 2',
      'Presentation frame 2: New note 1',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(frameNames()).toEqual([
      'Presentation frame 1: New note 1',
      'Presentation frame 2: New note 2',
    ]);

    const [firstFrame, secondFrame] = frameItems();
    fireEvent.dragStart(firstFrame!);
    fireEvent.dragOver(secondFrame!);
    fireEvent.drop(secondFrame!);
    expect(frameNames()).toEqual([
      'Presentation frame 1: New note 2',
      'Presentation frame 2: New note 1',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(frameNames()).toEqual([
      'Presentation frame 1: New note 1',
      'Presentation frame 2: New note 2',
    ]);
  });

  it('zooms to a visible persisted presentation frame in edgeless mode', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByText('Presentation order'));

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    expect(workspace.getAttribute('data-camera-zoom')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to New note 1' }));

    expect(Number(workspace.getAttribute('data-camera-zoom'))).toBeGreaterThan(1);
    expect(screen.getByLabelText('Canvas note').getAttribute('data-selected')).toBe('true');
  });

  it('persists undoable presenter notes and reveals them only on request while presenting', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByText('Presentation order'));

    const notes = screen.getByRole('textbox', { name: 'Presenter notes for New note 1' });
    fireEvent.change(notes, { target: { value: 'Pause and explain the tradeoff.' } });
    fireEvent.blur(notes);
    fireEvent.click(screen.getByRole('button', { name: 'Present canvas' }));

    expect(screen.queryByRole('note', { name: 'Presenter notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show presenter notes' }));
    expect(screen.getByRole('note', { name: 'Presenter notes' }).textContent).toContain(
      'Pause and explain the tradeoff.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Exit presentation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Presenter notes for New note 1',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('');
  });

  it('enters and exits real presentation fullscreen when the environment supports it', async () => {
    let fullscreenElement: Element | null = null;
    const requestFullscreenDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'requestFullscreen',
    );
    const exitFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
    const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'fullscreenElement',
    );
    const requestFullscreen = vi.fn(async function (this: Element) {
      fullscreenElement = this;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });

    try {
      render(<CanvasPage />);
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      fireEvent.click(screen.getByLabelText('Canvas note'));
      fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
      fireEvent.click(screen.getByRole('button', { name: 'Present canvas' }));
      fireEvent.click(screen.getByRole('button', { name: 'Enter presentation fullscreen' }));

      await waitFor(() => expect(requestFullscreen).toHaveBeenCalledOnce());
      expect(screen.getByRole('button', { name: 'Exit presentation fullscreen' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Exit presentation' }));
      await waitFor(() => expect(exitFullscreen).toHaveBeenCalledOnce());
      expect(screen.queryByRole('region', { name: 'Canvas presentation' })).toBeNull();
    } finally {
      if (requestFullscreenDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'requestFullscreen',
          requestFullscreenDescriptor,
        );
      } else {
        delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      }
      if (exitFullscreenDescriptor) {
        Object.defineProperty(document, 'exitFullscreen', exitFullscreenDescriptor);
      } else {
        delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      }
      if (fullscreenElementDescriptor) {
        Object.defineProperty(document, 'fullscreenElement', fullscreenElementDescriptor);
      } else {
        delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      }
    }
  });

  it('navigates presentation frames by controls and keyboard without editing content', () => {
    render(<CanvasPage />);
    const addNote = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addNote);
    fireEvent.click(addNote);
    const notes = screen.getAllByLabelText('Canvas note');

    fireEvent.click(notes[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(notes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Present canvas' }));

    const presentation = screen.getByRole('region', { name: 'Canvas presentation' });
    expect(within(presentation).getByText('New note 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next presentation frame' }));
    expect(within(presentation).getByText('New note 2')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(within(presentation).getByText('New note 1')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Canvas presentation' })).toBeNull();
  });

  it('copies, pastes, duplicates, and cuts selected blocks with keyboard commands', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(screen.getAllByDisplayValue('New note 1')).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(screen.getAllByDisplayValue('New note 1')).toHaveLength(3);

    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    expect(screen.getAllByDisplayValue('New note 1')).toHaveLength(2);
  });

  it('pastes an edgeless selection at the current world-space cursor', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByLabelText('Canvas note'));

    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerMove(workspace, { pointerId: 9, clientX: 900, clientY: 600 });
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });

    const notes = screen.getAllByLabelText('Canvas note');
    expect(notes).toHaveLength(2);
    expect(Number.parseFloat(notes[1].style.left)).toBe(300);
    expect(Number.parseFloat(notes[1].style.top)).toBe(200);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getAllByLabelText('Canvas note')).toHaveLength(1);
  });

  it('creates and edits shared text, heading, note, and code content across layouts', () => {
    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add heading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add code block' }));

    const text = screen.getByRole('textbox', { name: 'Edit text block' });
    fireEvent.change(text, { target: { value: 'Shared canvas content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit content' }));

    expect(
      (screen.getByRole('textbox', { name: 'Edit text block' }) as HTMLTextAreaElement).value,
    ).toBe('Shared canvas content');
    expect(screen.getByRole('textbox', { name: 'Edit heading block' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Edit note block' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Edit code block' })).toBeTruthy();
  });

  it('creates, branches, collapses, and undoes a canonical mind map', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    expect(screen.getByRole('region', { name: 'Mind map: New mind map 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add child to New mind map 1' }));
    expect(screen.getByText('New branch 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse New mind map 1' }));
    expect(screen.queryByText('New branch 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('New branch 1')).toBeTruthy();
  });

  it('adds a sibling and changes the persisted mind-map direction', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add child to New mind map 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add sibling to New branch 1' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Mind map direction' }), {
      target: { value: 'both' },
    });

    expect(screen.getByText('New branch 2')).toBeTruthy();
    expect(
      (screen.getByRole('combobox', { name: 'Mind map direction' }) as HTMLSelectElement).value,
    ).toBe('both');
  });

  it('navigates visible mind-map nodes with arrow keys', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add child to New mind map 1' }));
    const root = screen.getByRole('button', { name: 'Mind map node: New mind map 1' });
    const child = screen.getByRole('button', { name: 'Mind map node: New branch 1' });

    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(child);

    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(root);
  });

  it('changes persisted connector and root node styles', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Mind map connector style' }), {
      target: { value: 'elbow' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mind map root shape' }), {
      target: { value: 'pill' },
    });

    expect(
      (screen.getByRole('combobox', { name: 'Mind map connector style' }) as HTMLSelectElement)
        .value,
    ).toBe('elbow');
    expect(
      (screen.getByRole('combobox', { name: 'Mind map root shape' }) as HTMLSelectElement).value,
    ).toBe('pill');
  });

  it('reorders sibling branches through one undoable canonical transaction', () => {
    render(<CanvasPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add child to New mind map 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add sibling to New branch 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move New branch 2 before New branch 1' }));

    expect(
      screen
        .getAllByRole('button', { name: /Mind map node: New branch/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Mind map node: New branch 2', 'Mind map node: New branch 1']);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(
      screen
        .getAllByRole('button', { name: /Mind map node: New branch/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Mind map node: New branch 1', 'Mind map node: New branch 2']);
  });

  it('imports a validated canvas package as one undoable document replacement', async () => {
    let imported = createCanvasDocument({
      id: 'imported-canvas',
      projectId: 'local-project',
      ownerId: 'local-user',
      title: 'Imported ideas',
      now: 50,
    });
    imported = withBlockAdded(
      imported,
      createCanvasBlock({
        id: 'imported-note',
        content: { kind: 'note', text: 'Recovered portable idea' },
        now: 50,
      }),
      50,
    );
    const text = encodeCanvasPackage(imported);
    const file = new File([text], 'ideas.vibespace-canvas.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: async () => text });

    render(<CanvasPage />);
    fireEvent.change(screen.getByLabelText('Import canvas package'), {
      target: { files: [file] },
    });

    expect(await screen.findByDisplayValue('Recovered portable idea')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value).toBe(
      'Imported ideas',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByDisplayValue('Recovered portable idea')).toBeNull();
  });

  it('renders an imported mind map from the canonical document payload', async () => {
    let imported = createCanvasDocument({
      id: 'mind-map-import',
      projectId: 'local-project',
      ownerId: 'local-user',
      now: 50,
    });
    imported = withBlockAdded(
      imported,
      createCanvasBlock({
        id: 'mind-map-block',
        content: {
          kind: 'mind-map',
          map: createMindMap({
            id: 'mind-map',
            rootId: 'mind-map-root',
            label: 'Launch plan',
            now: 50,
          }),
        },
        now: 50,
      }),
      50,
    );
    const text = encodeCanvasPackage(imported);
    const file = new File([text], 'mind-map.vibespace-canvas.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: async () => text });

    render(<CanvasPage />);
    fireEvent.change(screen.getByLabelText('Import canvas package'), {
      target: { files: [file] },
    });

    expect(await screen.findByRole('region', { name: 'Mind map: Launch plan' })).toBeTruthy();
  });

  it('rejects a malformed package without replacing the current canvas', async () => {
    const text = '{"kind":"vibespace.canvas.package","packageVersion":999}';
    const file = new File([text], 'hostile.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => text });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('Import canvas package'), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/^Import failed:/)).toBeTruthy();
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('appends imported Markdown blocks as one undoable transaction', async () => {
    const markdown = [
      '# Imported heading',
      '',
      'Imported paragraph',
      '',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n');
    const file = new File([markdown], 'launch-notes.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: async () => markdown });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('Import Markdown document'), {
      target: { files: [file] },
    });

    expect(await screen.findByDisplayValue('Imported heading')).toBeTruthy();
    expect(screen.getByDisplayValue('Imported paragraph')).toBeTruthy();
    expect(screen.getByDisplayValue('const answer = 42;')).toBeTruthy();
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
    expect(screen.getByText('Imported 3 Markdown blocks from launch-notes.md')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.queryByDisplayValue('Imported heading')).toBeNull();
    expect(screen.queryByDisplayValue('Imported paragraph')).toBeNull();
    expect(screen.queryByDisplayValue('const answer = 42;')).toBeNull();
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('rejects an oversized Markdown file before reading or mutating the canvas', async () => {
    const file = new File(['x'.repeat(CANVAS_MARKDOWN_MAX_SOURCE_LENGTH + 1)], 'oversized.md', {
      type: 'text/markdown',
    });
    const read = vi.fn(async () => 'must not be read');
    Object.defineProperty(file, 'text', { value: read });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('Import Markdown document'), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/^Markdown import failed:/)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('New note 1')).toBeTruthy();
  });

  it('does not import a Markdown file after the active persistence scope changes', async () => {
    const otherScope: CanvasPersistenceScope = {
      accountId: 'account-b',
      projectId: 'project-b',
      ownerId: 'account-b',
    };
    const repository = persistenceRepository({
      loadLatest: vi.fn(async (scope) =>
        persistedDocument(scope, `canvas-${scope.accountId}`, `Canvas for ${scope.accountId}`),
      ),
    });
    let finishRead!: (source: string) => void;
    const source = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const file = new File(['# Cross-scope idea'], 'scope-race.md', { type: 'text/markdown' });
    Object.defineProperty(file, 'text', { value: () => source });
    const { rerender } = render(
      <CanvasPage persistence={{ repository, scope: PERSISTENCE_SCOPE }} />,
    );

    expect(await screen.findByDisplayValue('Canvas for account-a')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Import Markdown document'), {
      target: { files: [file] },
    });
    rerender(<CanvasPage persistence={{ repository, scope: otherScope }} />);
    expect(await screen.findByDisplayValue('Canvas for account-b')).toBeTruthy();
    finishRead('# Cross-scope idea');

    expect(await screen.findByText(/^Markdown import failed:/)).toBeTruthy();
    expect(screen.queryByDisplayValue('Cross-scope idea')).toBeNull();
    expect(screen.getByDisplayValue('Canvas for account-b')).toBeTruthy();
  });

  it('exports the current canonical canvas as a Markdown document download', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-markdown');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let downloadedAs = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedAs = this.download;
      });

    render(<CanvasPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Canvas title' }), {
      target: { value: 'Launch Notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Markdown document' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('text/markdown;charset=utf-8');
    expect(await readBlobText(blob!)).toBe('> New note 1');
    expect(downloadedAs).toBe('Launch-Notes.md');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:canvas-markdown');
    expect(screen.getByText('Markdown document exported')).toBeTruthy();
    click.mockRestore();
  });

  it('preserves mind-map content in a deterministic Markdown document export', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-mind-map-markdown');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let downloadedAs = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedAs = this.download;
      });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add mind map' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Markdown document' }));

    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('text/markdown;charset=utf-8');
    const markdown = await readBlobText(blob!);
    expect(markdown).toContain('```json');
    expect(markdown).toContain('"rootId":"mind-map-root-1"');
    expect(downloadedAs).toBe('Untitled-canvas.md');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:canvas-mind-map-markdown');
    expect(screen.getByText('Markdown document exported')).toBeTruthy();
    click.mockRestore();
  });

  it('exports selected objects as scaled SVG through compact visual export options', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-svg');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let downloadedAs = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedAs = this.download;
      });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getAllByRole('article', { name: 'Canvas note' })[0]!);
    fireEvent.click(screen.getByText('Visual exports'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas visual export format' }), {
      target: { value: 'svg' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas export scope' }), {
      target: { value: 'selection' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas export scale' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download canvas export' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('image/svg+xml');
    const svg = await readBlobText(blob!);
    expect(svg).toContain('width="2560"');
    expect(svg).toContain('height="1440"');
    expect(svg).toContain('New note 1');
    expect(svg).not.toContain('New note 2');
    expect(downloadedAs).toBe('Untitled-canvas.svg');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:canvas-svg');
    expect(screen.getByText('SVG export downloaded')).toBeTruthy();
    click.mockRestore();
  });

  it('exports only the selected persisted presentation frame', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-frame-svg');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getAllByRole('article', { name: 'Canvas note' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    fireEvent.click(screen.getByText('Visual exports'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas visual export format' }), {
      target: { value: 'svg' },
    });
    expect(
      (
        screen.getByRole('option', {
          name: 'Selected presentation frame',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas export scope' }), {
      target: { value: 'frame' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download canvas export' }));

    const svg = await readBlobText(createObjectURL.mock.calls[0]?.[0]!);
    expect(svg).toContain('New note 1');
    expect(svg).not.toContain('New note 2');
    click.mockRestore();
  });

  it.each([
    { format: 'png', mimeType: 'image/png', extension: '.png', signature: 'png' },
    { format: 'pdf', mimeType: 'application/pdf', extension: '.pdf', signature: 'pdf' },
  ])('downloads a canonical $format export', async ({ format, mimeType, extension, signature }) => {
    const createObjectURL = vi.fn((_blob: Blob) => `blob:canvas-${format}`);
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let downloadedAs = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedAs = this.download;
      });

    render(<CanvasPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Add heading' }));
    fireEvent.click(screen.getByText('Visual exports'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas visual export format' }), {
      target: { value: format },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download canvas export' }));

    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe(mimeType);
    const bytes = await readBlobBytes(blob!);
    if (signature === 'png') {
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    } else {
      expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.7');
    }
    expect(downloadedAs).toBe(`Untitled-canvas${extension}`);
    expect(revokeObjectURL).toHaveBeenCalledWith(`blob:canvas-${format}`);
    click.mockRestore();
  });

  it('enables a real presentation PDF only after a presentation frame exists', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-presentation');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    render(<CanvasPage />);
    fireEvent.click(screen.getByText('Visual exports'));
    expect(
      (
        screen.getByRole('option', {
          name: 'Presentation PDF',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('article', { name: 'Canvas note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show canvas properties' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected object to presentation' }));
    expect(
      (
        screen.getByRole('option', {
          name: 'Presentation PDF',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas export scope' }), {
      target: { value: 'selection' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Canvas visual export format' }), {
      target: { value: 'presentation-pdf' },
    });
    expect(
      (screen.getByRole('combobox', { name: 'Canvas export scope' }) as HTMLSelectElement).value,
    ).toBe('all');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      (screen.getByRole('button', { name: 'Download canvas export' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Download canvas export' }));

    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('application/pdf');
    expect(new TextDecoder().decode((await readBlobBytes(blob!)).slice(0, 8))).toBe('%PDF-1.7');
    expect(screen.getByText('Presentation PDF export downloaded')).toBeTruthy();
    click.mockRestore();
  });

  it('exports the current canonical canvas as a portable package download', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:canvas-package');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    let downloadedAs = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedAs = this.download;
      });

    render(<CanvasPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Canvas title' }), {
      target: { value: 'Launch Plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export canvas package' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(downloadedAs).toBe('Launch-Plan.vibespace-canvas.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:canvas-package');
    expect(screen.getByText('Canvas package exported')).toBeTruthy();
    click.mockRestore();
  });
});
