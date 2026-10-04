import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasPage } from './CanvasPage';
import { createCanvasDocument } from './contracts';
import { exportCanvas } from './importExport';
import type { CanvasPersistenceRepository, CanvasPersistenceScope } from './persistence';

const scope: CanvasPersistenceScope = {
  accountId: 'account-a',
  projectId: 'project-a',
  ownerId: 'account-a',
};

function repository(): CanvasPersistenceRepository {
  let saved = createCanvasDocument({
    id: 'a2qa-canvas',
    projectId: scope.projectId,
    ownerId: scope.ownerId,
    now: 1,
  });
  return {
    save: vi.fn(async (_scope, document) => {
      saved = document;
      return { localRevision: document.localRevision } as never;
    }),
    load: vi.fn(async () => saved),
    list: vi.fn(async () => [saved]),
    loadLatest: vi.fn(async () => saved),
    writeRecovery: vi.fn(async () => undefined),
    clearRecovery: vi.fn(async () => undefined),
    listRecovery: vi.fn(async () => []),
    listRevisions: vi.fn(async () => []),
  };
}

describe('CanvasPage drawing and image entry points', () => {
  it('offers pencil and marker tools and commits a completed pencil stroke only', async () => {
    const persistence = repository();
    render(<CanvasPage persistence={{ repository: persistence, scope, autosaveDelayMs: 0 }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value,
      ).toBe('Untitled'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pencil tool' }));
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerDown(workspace, { pointerId: 7, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(workspace, { pointerId: 7, clientX: 80, clientY: 72 });
    fireEvent.pointerUp(workspace, { pointerId: 7, clientX: 80, clientY: 72 });
    expect(await screen.findByRole('article', { name: 'Canvas stroke' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Canvas stroke' }).className).toContain(
      'canvas-ink-object',
    );
    expect(screen.getByRole('button', { name: 'Marker tool' })).toBeTruthy();
    await waitFor(() => expect(persistence.save).toHaveBeenCalled());
    const latest = vi.mocked(persistence.save).mock.lastCall?.[1];
    expect(latest?.blocks[0].content).toMatchObject({ kind: 'stroke', tool: 'pencil' });
  });

  it('discards a canceled marker gesture without changing the saved document', async () => {
    const persistence = repository();
    render(<CanvasPage persistence={{ repository: persistence, scope, autosaveDelayMs: 0 }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value,
      ).toBe('Untitled'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edgeless layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Marker tool' }));
    const workspace = screen.getByRole('region', { name: 'Canvas workspace' });
    fireEvent.pointerDown(workspace, { pointerId: 9, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(workspace, { pointerId: 9, clientX: 90, clientY: 80 });
    fireEvent.pointerCancel(workspace, { pointerId: 9, clientX: 90, clientY: 80 });
    expect(screen.queryByRole('article', { name: 'Canvas stroke' })).toBeNull();
    expect(workspace.querySelector('[data-canvas-ink-preview]')).toBeNull();
    const latest = vi.mocked(persistence.save).mock.lastCall?.[1];
    expect(latest?.blocks ?? []).toHaveLength(0);
  });

  it('imports a bounded PNG and reports a corrupt image without replacing the canvas', async () => {
    const persistence = repository();
    const view = render(
      <CanvasPage persistence={{ repository: persistence, scope, autosaveDelayMs: 0 }} />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Canvas title' }) as HTMLInputElement).value,
      ).toBe('Untitled'),
    );
    const bytes = exportCanvas(
      createCanvasDocument({ id: 'pixel-doc', projectId: 'p', ownerId: 'o', now: 1 }),
      { format: 'png', width: 2, height: 2 },
    ).bytes;
    const upload = screen.getByLabelText('Upload canvas image');
    const imageBuffer = new ArrayBuffer(bytes.length);
    new Uint8Array(imageBuffer).set(bytes);
    fireEvent.change(upload, {
      target: { files: [new File([imageBuffer], 'qa.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((item) => item.textContent)
          .join(' '),
      ).toContain('Imported image qa.png'),
    );
    expect(screen.getByRole('article', { name: 'Canvas image' })).toBeTruthy();
    fireEvent.change(upload, {
      target: { files: [new File(['bad'], 'bad.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .map((item) => item.textContent)
          .join(' '),
      ).toMatch(/Image import failed/),
    );
    expect(screen.getAllByRole('article', { name: 'Canvas image' })).toHaveLength(1);
    await waitFor(() => expect(persistence.save).toHaveBeenCalled());
    view.unmount();
    render(<CanvasPage persistence={{ repository: persistence, scope, autosaveDelayMs: 0 }} />);
    expect(await screen.findByRole('article', { name: 'Canvas image' })).toBeTruthy();
  });
});
