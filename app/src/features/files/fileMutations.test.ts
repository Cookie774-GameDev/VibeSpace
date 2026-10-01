import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { deleteProjectFile, renameProjectFile } from '@/lib/fs';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('bounded project file mutations', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it('renames through the root-contained native file command', async () => {
    await expect(
      renameProjectFile('C:\\project\\old.md', 'C:\\project\\new.md', {
        root: 'C:\\project',
      }),
    ).resolves.toEqual({ ok: true, path: 'C:\\project\\new.md' });
    expect(invoke).toHaveBeenCalledWith('fs_rename_file', {
      path: 'C:\\project\\old.md',
      newPath: 'C:\\project\\new.md',
      root: 'C:\\project',
    });
  });

  it('deletes through the root-contained native file command', async () => {
    await expect(
      deleteProjectFile('C:\\project\\old.md', { root: 'C:\\project' }),
    ).resolves.toEqual({ ok: true, path: 'C:\\project\\old.md' });
    expect(invoke).toHaveBeenCalledWith('fs_delete_file', {
      path: 'C:\\project\\old.md',
      root: 'C:\\project',
    });
  });
});
