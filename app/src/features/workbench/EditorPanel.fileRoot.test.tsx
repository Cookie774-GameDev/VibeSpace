// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPanel } from './EditorPanel';
import type { WorkbenchPanel } from './types';
import { preserveEditorLineEndings } from './editorText';
const fixture = vi.hoisted(() => ({ project: 'S61B1-A', read: vi.fn(), write: vi.fn(), preview: vi.fn() }));
vi.mock('@/stores/auth', () => ({ useAuthStore: (select: (s: { projectId: string }) => unknown) => select({ projectId: fixture.project }) }));
vi.mock('@/lib/fs', () => ({ readTextFile: fixture.read, writeTextFile: fixture.write, describeFsError: () => 'error' }));
vi.mock('./store', () => {
  const useWorkbenchStore = Object.assign((select: (s: { openDevicePreview: typeof fixture.preview }) => unknown) => select({ openDevicePreview: fixture.preview }), { getState: () => ({ panels: [] }) });
  return { useWorkbenchStore };
});
vi.mock('@/features/files/projectFiles', () => ({ basename: () => 'exact.txt', extension: () => 'txt', isPopularTextFile: () => true, getStoredProjectRoot: (id: string) => 'C:\\' + id }));
vi.mock('./WorkbenchSaveControls', () => ({ WorkbenchSaveControls: ({ onSave }: { onSave: () => void }) => <button onClick={onSave}>Save</button> }));
const folder = String.raw`C:\S61B1-own`, file = folder + '\\exact.txt';
const content = 'S61B1 exact large text Ω\r\n'.repeat(6000);
const panel: WorkbenchPanel = { id: 'S61B1-editor', kind: 'editor', title: 'exact.txt', x: 0, y: 0, width: 700, height: 500, z: 1, minimized: false, status: 'idle', settings: { filePath: file, cwd: folder } };
const settled = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
describe('editor filesystem scope follows its opened file', () => {
  beforeEach(() => {
    fixture.project = 'S61B1-A'; fixture.read.mockReset(); fixture.read.mockResolvedValue({ ok: true, content });
    fixture.write.mockReset(); fixture.write.mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);
  it('reads a large file within the independent folder rather than the active project root', async () => {
    render(<EditorPanel panel={panel} onUpdate={vi.fn()} />); await settled();
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(120_000);
    expect(fixture.read).toHaveBeenCalledWith(file, { root: folder });
    expect((screen.getByRole('textbox', { name: 'Editor content' }) as HTMLTextAreaElement).value).toBe(content.replace(/\r\n/g, '\n'));
  });
  it('preserves a bound unsaved edit through a project switch and saves exact bytes to its original root', async () => {
    const view = render(<EditorPanel panel={panel} onUpdate={vi.fn()} />); await settled();
    const edited = content + 'S61B1 unchanged folder after project switch';
    fireEvent.change(screen.getByRole('textbox', { name: 'Editor content' }), { target: { value: edited } });
    fixture.project = 'S61B1-B'; view.rerender(<EditorPanel panel={panel} onUpdate={vi.fn()} />); await settled();
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Editor content' }) as HTMLTextAreaElement).value).toBe(edited.replace(/\r\n/g, '\n'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ })); await settled();
    expect(fixture.write).toHaveBeenCalledWith(file, edited, { root: folder });
  });
  it('retains the active project root fallback for unbound legacy editors', async () => {
    render(<EditorPanel panel={{ ...panel, settings: { filePath: file } }} onUpdate={vi.fn()} />); await settled();
    expect(fixture.read).toHaveBeenCalledWith(file, { root: String.raw`C:\S61B1-A` });
  });
  it('pins an unbound legacy file to its initial root so a project switch cannot erase an unsaved edit', async () => {
    const legacy = { ...panel, settings: { filePath: file } };
    const view = render(<EditorPanel panel={legacy} onUpdate={vi.fn()} />); await settled();
    const edited = content + 'S61B1 protected legacy edit';
    fireEvent.change(screen.getByRole('textbox', { name: 'Editor content' }), { target: { value: edited } });
    fixture.project = 'S61B1-B'; view.rerender(<EditorPanel panel={legacy} onUpdate={vi.fn()} />); await settled();
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Editor content' }) as HTMLTextAreaElement).value).toBe(edited.replace(/\r\n/g, '\n'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ })); await settled();
    expect(fixture.write).toHaveBeenCalledWith(file, edited, { root: String.raw`C:\S61B1-A` });
  });
  it('keeps untouched mixed line endings when a visible line is edited', () => {
    const original = 'first\r\nsecond\nthird\rfourth\r\n';
    expect(preserveEditorLineEndings(original, 'first\nSECOND\nthird\nfourth\n')).toBe('first\r\nSECOND\nthird\rfourth\r\n');
  });
  it('keeps exact original newline bytes for unchanged visible text and uses CRLF for inserted lines', () => {
    const original = 'first\r\nlast\r\n';
    expect(preserveEditorLineEndings(original, 'first\nlast\n')).toBe(original);
    expect(preserveEditorLineEndings(original, 'first\ninserted\nlast\n')).toBe('first\r\ninserted\r\nlast\r\n');
  });
});
