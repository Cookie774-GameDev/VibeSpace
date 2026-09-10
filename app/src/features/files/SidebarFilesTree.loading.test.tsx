import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listDirectory } from '@/lib/fs';
import { SidebarFilesTree } from './SidebarFilesTree';
import { setStoredProjectRoot } from './projectFiles';

vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: (state: { projectId: string }) => unknown) =>
    select({ projectId: 'm202' }),
}));
vi.mock('@/lib/fs', () => ({
  listDirectory: vi.fn(),
  describeFsError: () => 'Could not load folder',
}));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(listDirectory).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('does not show an earlier root after its request completes late', async () => {
  let finish!: (value: any) => void;
  vi.mocked(listDirectory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(listDirectory).mockResolvedValueOnce({
    ok: true,
    path: 'C:\\new',
    entries: [{ name: 'new.txt', path: 'C:\\new\\new.txt', isDir: false }],
  });
  setStoredProjectRoot('m202', 'C:\\old');
  render(<SidebarFilesTree navOpen active onOpenFiles={() => undefined} />);
  await act(async () => {
    setStoredProjectRoot('m202', 'C:\\new');
  });
  await act(async () => {
    finish({
      ok: true,
      path: 'C:\\old',
      entries: [{ name: 'old.txt', path: 'C:\\old\\old.txt', isDir: false }],
    });
  });
  expect(screen.queryByText('old.txt')).toBeNull();
  expect(screen.getByText('new.txt')).toBeTruthy();
});

it('offers the remaining directory entries instead of silently truncating them', async () => {
  vi.mocked(listDirectory).mockResolvedValue({
    ok: true,
    path: 'C:\\large',
    entries: Array.from({ length: 121 }, (_, i) => ({
      name: `file-${i}.txt`,
      path: `C:\\large\\file-${i}.txt`,
      isDir: false,
    })),
  });
  setStoredProjectRoot('m202', 'C:\\large');
  render(<SidebarFilesTree navOpen active onOpenFiles={() => undefined} />);
  await screen.findByText('file-0.txt');
  fireEvent.click(screen.getByRole('button', { name: /show more/i }));
  expect(screen.getByText('file-120.txt')).toBeTruthy();
});
