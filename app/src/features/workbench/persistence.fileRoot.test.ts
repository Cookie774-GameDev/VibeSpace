import { beforeEach, describe, expect, it } from 'vitest';
import { emptyWorkbenchDocument, loadWorkbenchDocument, saveWorkbenchDocument, sanitizeWorkbenchDocument } from './persistence';
import type { WorkbenchPanel } from './types';
const folder = String.raw`C:\S61B1-own`;
const panel: WorkbenchPanel = { id: 'S61B1-isolated', kind: 'files', title: 'Files', x: 0, y: 0, width: 500, height: 400, z: 1, minimized: false, status: 'ready', settings: { cwd: folder, filesRootScope: 'panel' } };
beforeEach(() => window.localStorage.clear());
describe('persisted Files folder isolation', () => {
  it('retains the validated independent folder and bound editor across save/load', () => {
    const document = emptyWorkbenchDocument();
    document.panels = [panel, { ...panel, id: 'S61B1-editor', kind: 'editor', settings: { cwd: folder, filePath: folder + '\\exact.txt' } }];
    expect(saveWorkbenchDocument(document, window.localStorage).ok).toBe(true);
    const restored = loadWorkbenchDocument(window.localStorage).document;
    expect(restored.panels[0]?.settings).toMatchObject({ cwd: folder, filesRootScope: 'panel' });
    expect(restored.panels[1]?.settings).toMatchObject({ cwd: folder, filePath: folder + '\\exact.txt' });
  });
  it('rejects an arbitrary folder-scope value while keeping the legacy default unspecified', () => {
    const document = emptyWorkbenchDocument();
    const restored = sanitizeWorkbenchDocument({ ...document, panels: [{ ...panel, settings: { cwd: folder, filesRootScope: 'anything' } }, { ...panel, id: 'S61B1-legacy', settings: { cwd: folder } }] }, emptyWorkbenchDocument);
    expect(restored.panels[0]?.settings.filesRootScope).toBeUndefined();
    expect(restored.panels[1]?.settings.filesRootScope).toBeUndefined();
  });
});
