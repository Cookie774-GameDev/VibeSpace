// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPanel } from './FilesPanel';
import type { WorkbenchPanel } from './types';
import type { FsListResult } from '@/lib/fs';

const fixture = vi.hoisted(() => ({
  project: 'S61B1-A', roots: new Map<string, string>(),
  list: vi.fn<(path: string) => Promise<FsListResult>>(),
  storeRoot: vi.fn(), open: vi.fn(), picker: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('@/lib/fs', () => ({ listDirectory: fixture.list, describeFsError: () => 'error' }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (select: (s: { projectId: string }) => unknown) => select({ projectId: fixture.project }) }));
vi.mock('./store', () => ({ useWorkbenchStore: (select: (s: { openFileInEditor: typeof fixture.open }) => unknown) => select({ openFileInEditor: fixture.open }) }));
vi.mock('@/features/files/projectFiles', () => ({
  basename: (path: string) => path.split(/[\\/]/u).pop() ?? path,
  chooseProjectFolder: fixture.picker, isPopularTextFile: () => true,
  getStoredProjectRoot: (id: string | null) => fixture.roots.get(id ?? '') ?? '',
  setStoredProjectRoot: (id: string | null, path: string) => {
    fixture.storeRoot(id, path); fixture.roots.set(id ?? '', path);
    window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', { detail: { projectId: id, path } }));
  },
}));
const shared = String.raw`C:\S61B1-shared`, own = String.raw`C:\S61B1-own`;
function panel(id: string, independent = false): WorkbenchPanel {
  return { id, kind: 'files', title: 'Files', x: 0, y: 0, width: 500, height: 400, z: 1,
    minimized: false, status: 'idle', settings: independent ? { cwd: own, filesRootScope: 'panel' } : {} };
}
function listing(path: string): FsListResult {
  return { ok: true, path, entries: [{ name: 'own.txt', path: path + '\\own.txt', isDir: false }] };
}
function Harness({ initial }: { initial: WorkbenchPanel }) {
  const [current, setCurrent] = React.useState(initial);
  return <FilesPanel panel={current} onUpdate={patch => setCurrent(previous => ({ ...previous, ...patch,
    settings: { ...previous.settings, ...patch.settings } }))} />;
}
const settled = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
describe('independent Files pane boundaries', () => {
  beforeEach(() => {
    fixture.project = 'S61B1-A'; fixture.roots.clear(); fixture.roots.set(fixture.project, shared);
    fixture.list.mockReset(); fixture.list.mockImplementation(async path => listing(path));
    fixture.storeRoot.mockClear(); fixture.open.mockReset(); fixture.open.mockReturnValue('S61B1-editor');
    fixture.picker.mockReset(); fixture.picker.mockResolvedValue(null);
  });
  afterEach(cleanup);
  it('lists a second independent folder without changing a mounted legacy pane or shared root', async () => {
    render(<><Harness initial={panel('S61B1-legacy')} /><Harness initial={panel('S61B1-independent', true)} /></>);
    await settled();
    const inputs = screen.getAllByLabelText('Project folder path') as HTMLInputElement[];
    expect(inputs.map(input => input.value)).toEqual([shared, own]);
    expect(fixture.roots.get(fixture.project)).toBe(shared);
    expect(fixture.storeRoot).not.toHaveBeenCalled();
  });
  it('ignores project root broadcasts and project switches for an independent pane', async () => {
    const view = render(<FilesPanel panel={panel('S61B1-independent', true)} onUpdate={vi.fn()} />);
    await settled(); const calls = fixture.list.mock.calls.length;
    await act(async () => window.dispatchEvent(new CustomEvent('jarvis:files:root-changed', { detail: { projectId: fixture.project, path: String.raw`C:\S61B1-other` } })));
    fixture.project = 'S61B1-B'; fixture.roots.set(fixture.project, String.raw`C:\S61B1-B`);
    view.rerender(<FilesPanel panel={panel('S61B1-independent', true)} onUpdate={vi.fn()} />);
    await settled();
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe(own);
    expect(fixture.list).toHaveBeenCalledTimes(calls);
    expect(fixture.storeRoot).not.toHaveBeenCalled();
  });
  it('opens a file using its independent folder boundary', async () => {
    render(<Harness initial={panel('S61B1-independent', true)} />); await settled();
    fireEvent.click(screen.getByRole('button', { name: 'own.txt' }));
    expect(fixture.open).toHaveBeenCalledWith(own + '\\own.txt', own);
  });
  it('returns to the shared folder without publishing the independent path', async () => {
    render(<Harness initial={panel('S61B1-independent', true)} />); await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Independent folder' })); await settled();
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe(shared);
    expect(fixture.storeRoot).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Independent folder' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('does not apply a late folder picker result after leaving independent mode', async () => {
    let finish!: (path: string) => void;
    fixture.picker.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<Harness initial={panel('S61B1-independent', true)} />); await settled();
    fireEvent.click(within(screen.getByTestId('workbench-files-panel')).getByRole('button', { name: /^Choose folder$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Independent folder' })); await settled();
    await act(async () => finish(String.raw`C:\S61B1-late`));
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe(shared);
    expect(fixture.list.mock.calls.some(([path]) => path.endsWith('late'))).toBe(false);
    expect(fixture.storeRoot).not.toHaveBeenCalled();
  });
  it('uses the new project root after a mounted shared pane has published its old cwd', async () => {
    const view = render(<Harness initial={panel('S61B1-legacy')} />); await settled();
    const next = String.raw`C:\S61B1-B`;
    fixture.project = 'S61B1-B'; fixture.roots.set(fixture.project, next);
    view.rerender(<Harness initial={panel('S61B1-legacy')} />); await settled();
    expect((screen.getByLabelText('Project folder path') as HTMLInputElement).value).toBe(next);
    expect(fixture.roots.get('S61B1-B')).toBe(next);
    expect(fixture.roots.get('S61B1-A')).toBe(shared);
    expect(fixture.list).toHaveBeenLastCalledWith(next, { root: next });
    expect(fixture.storeRoot).not.toHaveBeenCalled();
  });
});
