import { beforeEach, describe, expect, it } from 'vitest';

import type { ProjectId } from '@/types';
import {
  activateWorkspaceFile,
  clampFilesSidebarWidth,
  closeWorkspaceFile,
  fileWorkspaceTabLabel,
  getFileWorkspaceState,
  openWorkspaceFile,
  patchWorkspaceTab,
  reconcileWorkspaceFile,
  renameWorkspaceFile,
  resetFileWorkspaceForTests,
  setAskPanelCollapsed,
  setAskPanelDefault,
  setFilesSidebarWidth,
} from './fileWorkspaceStore';

const projectA = 'project-a' as ProjectId;
const projectB = 'project-b' as ProjectId;

describe('fileWorkspaceStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFileWorkspaceForTests();
  });

  it('isolates tabs and unsaved buffers between projects', () => {
    openWorkspaceFile(projectA, 'C:\\a\\one.ts', 'saved');
    patchWorkspaceTab(projectA, 'C:\\a\\one.ts', { content: 'unsaved' });
    openWorkspaceFile(projectB, 'C:\\b\\one.ts', 'other');

    expect(getFileWorkspaceState(projectA).tabs[0]?.content).toBe('unsaved');
    expect(getFileWorkspaceState(projectB).tabs[0]?.content).toBe('other');
  });

  it('keeps multiple files open and chooses a neighboring tab on close', () => {
    openWorkspaceFile(projectA, 'one.ts', 'one');
    openWorkspaceFile(projectA, 'two.ts', 'two');
    activateWorkspaceFile(projectA, 'one.ts');
    closeWorkspaceFile(projectA, 'one.ts');

    expect(getFileWorkspaceState(projectA).tabs.map((tab) => tab.path)).toEqual(['two.ts']);
    expect(getFileWorkspaceState(projectA).activePath).toBe('two.ts');
  });

  it('persists only paths and layout, never file or assistant contents', () => {
    openWorkspaceFile(projectA, 'secret.ts', 'private source');
    patchWorkspaceTab(projectA, 'secret.ts', {
      askDraft: 'private question',
      assistantLines: [{ id: 'a', role: 'assistant', text: 'private answer' }],
    });
    setFilesSidebarWidth(projectA, 999);
    setAskPanelCollapsed(projectA, true);
    setAskPanelDefault(projectA, false);

    const persisted = [...Array(window.localStorage.length)]
      .map((_, index) => window.localStorage.getItem(window.localStorage.key(index) ?? ''))
      .join('');
    expect(persisted).toContain('secret.ts');
    expect(persisted).not.toContain('private source');
    expect(persisted).not.toContain('private question');
    expect(persisted).not.toContain('private answer');
    expect(getFileWorkspaceState(projectA).sidebarWidth).toBe(560);
  });

  it('clamps the sidebar to usable bounds', () => {
    expect(clampFilesSidebarWidth(80)).toBe(240);
    expect(clampFilesSidebarWidth(420.4)).toBe(420);
    expect(clampFilesSidebarWidth(900)).toBe(560);
  });

  it('disambiguates duplicate filenames with their parent folder', () => {
    const paths = ['C:\\one\\index.ts', 'C:\\two\\index.ts', 'C:\\two\\other.ts'];
    expect(fileWorkspaceTabLabel(paths[0], paths)).toBe('one/index.ts');
    expect(fileWorkspaceTabLabel(paths[1], paths)).toBe('two/index.ts');
    expect(fileWorkspaceTabLabel(paths[2], paths)).toBe('other.ts');
  });

  it('reconciles external rename/delete without losing an unsaved buffer', () => {
    openWorkspaceFile(projectA, 'clean.ts', 'clean');
    openWorkspaceFile(projectA, 'dirty.ts', 'saved');
    patchWorkspaceTab(projectA, 'dirty.ts', { content: 'unsaved' });

    expect(reconcileWorkspaceFile(projectA, 'clean.ts', { ok: false })).toBe('closed-missing');
    expect(reconcileWorkspaceFile(projectA, 'dirty.ts', { ok: false })).toBe('preserved-unsaved');
    expect(getFileWorkspaceState(projectA).tabs.map((tab) => tab.path)).toEqual(['dirty.ts']);
    expect(getFileWorkspaceState(projectA).tabs[0]?.content).toBe('unsaved');
  });

  it('renames an open file without losing its editor state or active selection', () => {
    openWorkspaceFile(projectA, 'C:\\project\\before.ts', 'saved');
    patchWorkspaceTab(projectA, 'C:\\project\\before.ts', {
      askDraft: 'keep this private draft in memory',
    });

    expect(renameWorkspaceFile(projectA, 'C:\\project\\before.ts', 'C:\\project\\after.ts')).toBe(
      true,
    );
    expect(getFileWorkspaceState(projectA).activePath).toBe('C:\\project\\after.ts');
    expect(getFileWorkspaceState(projectA).tabs).toEqual([
      expect.objectContaining({
        path: 'C:\\project\\after.ts',
        content: 'saved',
        askDraft: 'keep this private draft in memory',
      }),
    ]);
  });
});
