import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkbenchPage } from './WorkbenchPage';
import { useWorkbenchStore } from './store';

const renders = vi.hoisted(() => ({ wallpaper: 0 }));
vi.mock('./WorkbenchCanvas', () => ({ WorkbenchCanvas: () => null }));
vi.mock('./ReferencePanel', () => ({
  ArtifactReferenceResolverProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./WallpaperHost', () => ({
  WallpaperHost: () => {
    renders.wallpaper++;
    return null;
  },
}));

it('does not rerender the Workbench shell when undo snapshots change but availability stays enabled', async () => {
  useWorkbenchStore.getState().resetWorkbench();
  useWorkbenchStore.getState().addPanel('notes');
  render(<WorkbenchPage />);
  await act(async () => Promise.resolve());
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
  const before = renders.wallpaper;
  act(() => {
    useWorkbenchStore.getState().addPanel('notes');
  });
  expect(renders.wallpaper - before).toBe(0);
});
