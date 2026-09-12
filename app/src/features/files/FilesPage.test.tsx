import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFileWorkspaceForTests } from './fileWorkspaceStore';

const { deleteProjectFileMock, renameProjectFileMock } = vi.hoisted(() => ({
  deleteProjectFileMock: vi.fn(),
  renameProjectFileMock: vi.fn(),
}));

const fileContents = new Map([
  ['C:\\project\\one.ts', 'const one = 1;'],
  ['C:\\project\\two.ts', 'const two = 2;'],
]);

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      projectId: 'project-files',
      chatModelSelection: null,
    }),
}));

vi.mock('@/stores/agents', () => ({
  useAgentStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ agents: {} }),
}));

vi.mock('@/lib/jarvis/identity', () => ({
  findProtectedJarvisAgent: () => null,
}));

vi.mock('@/lib/ai/router', () => ({
  runAgent: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  listDirectory: vi.fn(async () => ({
    ok: true,
    path: 'C:\\project',
    entries: [
      { name: 'one.ts', path: 'C:\\project\\one.ts', isDir: false, size: 14 },
      { name: 'two.ts', path: 'C:\\project\\two.ts', isDir: false, size: 14 },
    ],
  })),
  readTextFile: vi.fn(async (path: string) => {
    const content = fileContents.get(path);
    return content === undefined
      ? { ok: false, error: { code: 'NOT_FOUND', message: 'Missing' } }
      : { ok: true, path, content };
  }),
  writeTextFile: vi.fn(async () => ({ ok: true })),
  createTextFile: vi.fn(async () => ({ ok: true })),
  renameProjectFile: renameProjectFileMock,
  deleteProjectFile: deleteProjectFileMock,
  describeFsError: (error: { message?: string }) => error.message ?? 'File error',
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { FilesPage } from './FilesPage';

describe('FilesPage workspace flow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFileWorkspaceForTests();
    fileContents.set('C:\\project\\one.ts', 'const one = 1;');
    fileContents.set('C:\\project\\two.ts', 'const two = 2;');
    renameProjectFileMock.mockReset();
    renameProjectFileMock.mockImplementation(async (path: string, nextPath: string) => {
      const content = fileContents.get(path);
      if (content !== undefined) {
        fileContents.delete(path);
        fileContents.set(nextPath, content);
      }
      return { ok: true, path: nextPath };
    });
    deleteProjectFileMock.mockReset();
    deleteProjectFileMock.mockImplementation(async (path: string) => {
      fileContents.delete(path);
      return { ok: true, path };
    });
  });

  afterEach(cleanup);

  it('keeps unsaved edits across file tabs and collapses Ask Jarvis without losing the file', async () => {
    render(<FilesPage />);

    fireEvent.change(screen.getByLabelText('Project folder path'), {
      target: { value: 'C:\\project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const oneTreeLabel = await screen.findByText('one.ts');
    fireEvent.click(oneTreeLabel.closest('button')!);
    const editor = await screen.findByLabelText('File contents');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('const one = 1;'));
    fireEvent.change(editor, { target: { value: 'const one = 99;' } });

    const twoTreeLabel = screen.getByText('two.ts');
    fireEvent.click(twoTreeLabel.closest('button')!);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('const two = 2;'));
    fireEvent.click(screen.getByRole('tab', { name: /one\.ts/i }));
    expect((editor as HTMLTextAreaElement).value).toBe('const one = 99;');
    expect(screen.getByText('Unsaved')).toBeTruthy();

    const collapse = screen.getByRole('button', { name: /Collapse .* file panel/i });
    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: /Expand .* file panel/i })).toBeTruthy();
    expect((screen.getByLabelText('File contents') as HTMLTextAreaElement).value).toBe(
      'const one = 99;',
    );
  });

  it('renames only saved files and keeps unsaved edits intact', async () => {
    render(<FilesPage />);
    fireEvent.change(screen.getByLabelText('Project folder path'), {
      target: { value: 'C:\\project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click((await screen.findByText('one.ts')).closest('button')!);
    const editor = await screen.findByLabelText('File contents');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('const one'));
    fireEvent.change(editor, { target: { value: 'private unsaved edit' } });

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('renamed.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Rename selected file' }));
    expect(prompt).not.toHaveBeenCalled();
    expect(renameProjectFileMock).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe('private unsaved edit');

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(screen.queryByText('Unsaved')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Rename selected file' }));
    await waitFor(() =>
      expect(renameProjectFileMock).toHaveBeenCalledWith(
        'C:\\project\\one.ts',
        'C:\\project\\renamed.ts',
        { root: 'C:\\project' },
      ),
    );
    prompt.mockRestore();
  });

  it('requires explicit confirmation before deleting an unsaved file', async () => {
    render(<FilesPage />);
    fireEvent.change(screen.getByLabelText('Project folder path'), {
      target: { value: 'C:\\project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click((await screen.findByText('two.ts')).closest('button')!);
    const editor = await screen.findByLabelText('File contents');
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('const two'));
    fireEvent.change(editor, { target: { value: 'unsaved private edit' } });

    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected file' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('discard its unsaved changes'));
    expect(deleteProjectFileMock).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe('unsaved private edit');

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected file' }));
    await waitFor(() =>
      expect(deleteProjectFileMock).toHaveBeenCalledWith('C:\\project\\two.ts', {
        root: 'C:\\project',
      }),
    );
    confirm.mockRestore();
  });

  it('refuses a rename that collides with another open tab before touching disk', async () => {
    render(<FilesPage />);
    fireEvent.change(screen.getByLabelText('Project folder path'), {
      target: { value: 'C:\\project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click((await screen.findByText('one.ts')).closest('button')!);
    await screen.findByLabelText('File contents');
    fireEvent.click(screen.getByText('two.ts').closest('button')!);
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    fireEvent.click(screen.getByRole('tab', { name: /one\.ts/i }));

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('TWO.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Rename selected file' }));

    expect(renameProjectFileMock).not.toHaveBeenCalled();
    expect(fileContents.has('C:\\project\\one.ts')).toBe(true);
    expect(fileContents.has('C:\\project\\two.ts')).toBe(true);
    prompt.mockRestore();
  });
});
