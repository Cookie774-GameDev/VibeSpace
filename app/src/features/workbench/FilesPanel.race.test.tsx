// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPanel } from './FilesPanel';
import type { WorkbenchPanel } from './types';
import type { FsListResult } from '@/lib/fs';

const fixtures = vi.hoisted(() => ({
  projectId: 'S61B1-A',
  roots: new Map<string, string>(),
  emitted: 0,
  list: vi.fn<(path: string) => Promise<FsListResult>>(),
  save: vi.fn<(projectId: string | null, path: string) => void>(),
}));
vi.mock('@/lib/fs', () => ({
  listDirectory: fixtures.list,
  describeFsError: (error: { code: string }) => error.code,
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: (s: { projectId: string }) => unknown) =>
    select({ projectId: fixtures.projectId }),
}));
vi.mock('./store', () => ({
  useWorkbenchStore: (select: (s: { openFileInEditor: () => null }) => unknown) =>
    select({ openFileInEditor: () => null }),
}));
vi.mock('@/features/files/projectFiles', () => ({
  basename: (path: string) => path.split(/[\\/]/u).pop() ?? path,
  chooseProjectFolder: vi.fn(async () => null),
  isPopularTextFile: () => true,
  getStoredProjectRoot: (projectId: string | null) => fixtures.roots.get(projectId ?? '') ?? '',
  setStoredProjectRoot: (projectId: string | null, path: string) => {
    fixtures.save(projectId, path);
    fixtures.roots.set(projectId ?? '', path);
    // Match the real helper for four events, then bound the old component's
    // runaway recursion. The product under test is unchanged in the red fixture.
    if (fixtures.emitted++ < 4) {
      window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', { detail: { projectId, path } }));
    }
  },
}));
const panel: WorkbenchPanel = {
  id: 'S61B1-files', kind: 'files', title: 'Files', x: 0, y: 0,
  width: 500, height: 400, z: 1, minimized: false, status: 'idle', settings: {},
};
function listing(path: string): FsListResult {
  return { ok: true, path, entries: [{ name: path + '.txt', path: path + '\\x.txt', isDir: false }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
describe('Workbench FilesPanel root request ownership', () => {
  beforeEach(() => {
    fixtures.projectId = 'S61B1-A'; fixtures.roots.clear(); fixtures.emitted = 0;
    fixtures.roots.set('S61B1-A', String.raw`C:\S61B1-A`);
    fixtures.roots.set('S61B1-B', String.raw`C:\S61B1-B`);
    fixtures.list.mockReset(); fixtures.save.mockClear();
  });
  afterEach(cleanup);
  it('does not re-emit an unchanged root and recursively relist its own event', async () => {
    fixtures.list.mockImplementation(async path => {
      if (fixtures.list.mock.calls.length > 4) throw new Error('bounded old-loop detector');
      return listing(path);
    });
    render(<FilesPanel panel={panel} onUpdate={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fixtures.list).toHaveBeenCalledTimes(1);
    expect(fixtures.save).not.toHaveBeenCalled();
    expect(screen.getByRole('tree', { name: 'Project files' })).toBeTruthy();
  });
  it('ignores a previous project response after switching projects', async () => {
    const old = deferred<FsListResult>();
    fixtures.list.mockImplementation(path => path.endsWith('A') ? old.promise : Promise.resolve(listing(path)));
    const update = vi.fn();
    const view = render(<FilesPanel panel={panel} onUpdate={update} />);
    fixtures.projectId = 'S61B1-B';
    view.rerender(<FilesPanel panel={panel} onUpdate={update} />);
    await act(async () => { await Promise.resolve(); });
    update.mockClear();
    await act(async () => { old.resolve(listing(String.raw`C:\S61B1-A`)); });
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe(String.raw`C:\S61B1-B`);
    expect(fixtures.save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight listing when the root is cleared', async () => {
    const old = deferred<FsListResult>(); fixtures.list.mockReturnValue(old.promise);
    const update = vi.fn(); render(<FilesPanel panel={panel} onUpdate={update} />);
    await act(async () => { fixtures.roots.set('S61B1-A', ''); window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', { detail: { projectId: 'S61B1-A', path: '' } })); });
    await act(async () => { old.resolve(listing(String.raw`C:\S61B1-A`)); });
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByText('No project folder', { selector: 'strong' }).length).toBeGreaterThan(0);
    expect(fixtures.save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('does not publish a completed listing after panel unmount', async () => {
    const old = deferred<FsListResult>(); fixtures.list.mockReturnValue(old.promise);
    const update = vi.fn(); const view = render(<FilesPanel panel={panel} onUpdate={update} />);
    view.unmount();
    await act(async () => { old.resolve(listing(String.raw`C:\S61B1-A`)); });
    expect(update).not.toHaveBeenCalled(); expect(fixtures.save).not.toHaveBeenCalled();
  });
});
