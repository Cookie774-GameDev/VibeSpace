import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFileWorkspaceForTests } from './fileWorkspaceStore';

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
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toBe('const one = 1;'),
    );
    fireEvent.change(editor, { target: { value: 'const one = 99;' } });

    const twoTreeLabel = screen.getByText('two.ts');
    fireEvent.click(twoTreeLabel.closest('button')!);
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toBe('const two = 2;'),
    );
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
});
