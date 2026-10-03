import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkbenchStore } from './store';
const file = String.raw`C:\S61B1-own\exact.txt`, root = String.raw`C:\S61B1-own`;
beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchStore.setState({ panels: [], history: [], future: [], selectedIds: [] });
});
describe('file editor folder binding', () => {
  it('binds an opened file to the Files pane folder', () => {
    const id = useWorkbenchStore.getState().openFileInEditor(file, ' ' + root + ' ');
    expect(useWorkbenchStore.getState().panels.find(panel => panel.id === id)?.settings).toMatchObject({ filePath: file, cwd: root });
  });
  it('reuses a matching bound file without replacing a differently scoped existing editor', () => {
    const existing = useWorkbenchStore.getState().addPanel('editor', undefined, { filePath: file, cwd: String.raw`C:\S61B1-other`, note: 'protected edits' });
    const before = structuredClone(useWorkbenchStore.getState().panels.find(panel => panel.id === existing));
    const opened = useWorkbenchStore.getState().openFileInEditor(file, root);
    expect(opened).not.toBe(existing);
    expect(useWorkbenchStore.getState().panels.find(panel => panel.id === existing)).toEqual(before);
    expect(useWorkbenchStore.getState().openFileInEditor(file, root)).toBe(opened);
    expect(useWorkbenchStore.getState().panels).toHaveLength(2);
  });
  it('clears an unrelated old folder when a truly empty editor is reused without a root', () => {
    const empty = useWorkbenchStore.getState().addPanel('editor', undefined, { cwd: root, note: '' });
    expect(useWorkbenchStore.getState().openFileInEditor(file)).toBe(empty);
    expect(useWorkbenchStore.getState().panels.find(panel => panel.id === empty)?.settings.cwd).toBeUndefined();
  });
  it('preserves an unbound legacy empty editor when an independent pane opens a file', () => {
    const empty = useWorkbenchStore.getState().addPanel('editor', undefined, { note: '' });
    const before = structuredClone(useWorkbenchStore.getState().panels.find(panel => panel.id === empty));
    expect(useWorkbenchStore.getState().openFileInEditor(file, root)).not.toBe(empty);
    expect(useWorkbenchStore.getState().panels.find(panel => panel.id === empty)).toEqual(before);
  });
});
