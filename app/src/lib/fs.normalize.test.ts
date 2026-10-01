import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compareAndSwapTextFile,
  copyProjectFile,
  createDirectory,
  createDirectoryWithReceipt,
  moveProjectFileWithReceipt,
  normalizeFsEntry,
  statProjectPath,
} from './fs';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('normalizeFsEntry', () => {
  beforeEach(() => invokeMock.mockReset());
  it('accepts camelCase IPC entries', () => {
    const entry = normalizeFsEntry({
      name: 'src',
      path: 'C:\\proj\\src',
      isDir: true,
      size: undefined,
    });
    expect(entry).toEqual({
      name: 'src',
      path: 'C:\\proj\\src',
      isDir: true,
      size: undefined,
      createdMs: undefined,
      modifiedMs: undefined,
    });
  });

  it('accepts snake_case IPC entries', () => {
    const entry = normalizeFsEntry({
      name: 'readme.md',
      path: '/home/u/readme.md',
      is_dir: false,
      size: 120,
      created_ms: 1,
      modified_ms: 2,
    });
    expect(entry).toMatchObject({
      name: 'readme.md',
      path: '/home/u/readme.md',
      isDir: false,
      size: 120,
      createdMs: 1,
      modifiedMs: 2,
    });
  });

  it('coerces numeric string timestamps and sizes from native IPC', () => {
    const entry = normalizeFsEntry({
      name: 'shot.png',
      path: 'C:\\Users\\viper\\Pictures\\shot.png',
      is_dir: false,
      size: '2048',
      modified_ms: '1783784948363',
      created_ms: '1783784948000',
    });
    expect(entry).toMatchObject({
      name: 'shot.png',
      isDir: false,
      size: 2048,
      modifiedMs: 1783784948363,
      createdMs: 1783784948000,
    });
  });

  it('returns null for incomplete payloads', () => {
    expect(normalizeFsEntry({})).toBeNull();
    expect(normalizeFsEntry(null)).toBeNull();
  });
});

describe('compareAndSwapTextFile', () => {
  beforeEach(() => invokeMock.mockReset());

  it('passes exact-base mutations to native authority and validates its receipt', async () => {
    invokeMock.mockResolvedValue({
      beforeSha256: `sha256:${'a'.repeat(64)}`,
      afterSha256: `sha256:${'b'.repeat(64)}`,
      beforeBytes: 6,
      afterBytes: 5,
    });

    await expect(
      compareAndSwapTextFile('C:\\repo\\notes.md', `sha256:${'a'.repeat(64)}`, 'after', {
        root: 'C:\\repo',
      }),
    ).resolves.toEqual({
      ok: true,
      path: 'C:\\repo\\notes.md',
      beforeSha256: `sha256:${'a'.repeat(64)}`,
      afterSha256: `sha256:${'b'.repeat(64)}`,
      beforeBytes: 6,
      afterBytes: 5,
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_compare_and_swap_text', {
      path: 'C:\\repo\\notes.md',
      expectedSha256: `sha256:${'a'.repeat(64)}`,
      nextContent: 'after',
      root: 'C:\\repo',
    });
  });

  it('normalizes stale-base and malformed native responses', async () => {
    invokeMock.mockRejectedValueOnce('stale_base');
    await expect(
      compareAndSwapTextFile('C:\\repo\\notes.md', `sha256:${'a'.repeat(64)}`, 'after', {
        root: 'C:\\repo',
      }),
    ).resolves.toEqual({
      ok: false,
      path: 'C:\\repo\\notes.md',
      error: { code: 'stale_base', raw: 'stale_base' },
    });

    invokeMock.mockResolvedValueOnce({
      beforeSha256: 'C:\\private\\secret',
      afterSha256: null,
      beforeBytes: -1,
      afterBytes: 0,
    });
    await expect(
      compareAndSwapTextFile('C:\\repo\\notes.md', null, 'after', { root: 'C:\\repo' }),
    ).resolves.toMatchObject({
      ok: false,
      path: 'C:\\repo\\notes.md',
      error: { code: 'unknown' },
    });
  });
});

describe('strict project metadata and transfers', () => {
  beforeEach(() => invokeMock.mockReset());

  it('validates bounded metadata and optional hashes', async () => {
    invokeMock.mockResolvedValue({
      kind: 'file',
      size: 12,
      createdMs: 100,
      modifiedMs: 200,
      sha256: `sha256:${'a'.repeat(64)}`,
    });

    await expect(
      statProjectPath('C:\\repo\\asset.bin', true, { root: 'C:\\repo' }),
    ).resolves.toEqual({
      ok: true,
      path: 'C:\\repo\\asset.bin',
      kind: 'file',
      size: 12,
      createdMs: 100,
      modifiedMs: 200,
      sha256: `sha256:${'a'.repeat(64)}`,
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_stat_path', {
      path: 'C:\\repo\\asset.bin',
      includeSha256: true,
      root: 'C:\\repo',
    });

    invokeMock.mockResolvedValueOnce({
      kind: 'directory',
      size: 12,
      sha256: `sha256:${'a'.repeat(64)}`,
    });
    await expect(statProjectPath('C:\\repo', true, { root: 'C:\\repo' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('returns native hash evidence for create-new copy and no-overwrite move', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(createDirectory('C:\\global\\legacy')).resolves.toEqual({
      ok: true,
      path: 'C:\\global\\legacy',
    });
    expect(invokeMock).toHaveBeenLastCalledWith('fs_create_dir_all', {
      path: 'C:\\global\\legacy',
      root: undefined,
    });

    invokeMock.mockResolvedValueOnce({ created: false });
    await expect(
      createDirectoryWithReceipt('C:\\repo\\existing', { root: 'C:\\repo' }),
    ).resolves.toEqual({
      ok: true,
      path: 'C:\\repo\\existing',
      created: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('fs_create_dir_all_strict', {
      path: 'C:\\repo\\existing',
      root: 'C:\\repo',
    });

    invokeMock.mockResolvedValue({
      bytes: 12,
      sha256: `sha256:${'b'.repeat(64)}`,
    });

    await expect(
      copyProjectFile('C:\\repo\\a.bin', 'C:\\repo\\b.bin', { root: 'C:\\repo' }),
    ).resolves.toEqual({
      ok: true,
      path: 'C:\\repo\\b.bin',
      sourcePath: 'C:\\repo\\a.bin',
      bytes: 12,
      sha256: `sha256:${'b'.repeat(64)}`,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('fs_copy_file', {
      path: 'C:\\repo\\a.bin',
      newPath: 'C:\\repo\\b.bin',
      root: 'C:\\repo',
    });

    await expect(
      moveProjectFileWithReceipt('C:\\repo\\b.bin', 'C:\\repo\\c.bin', { root: 'C:\\repo' }),
    ).resolves.toEqual({
      ok: true,
      path: 'C:\\repo\\c.bin',
      sourcePath: 'C:\\repo\\b.bin',
      bytes: 12,
      sha256: `sha256:${'b'.repeat(64)}`,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('fs_move_file_with_receipt', {
      path: 'C:\\repo\\b.bin',
      newPath: 'C:\\repo\\c.bin',
      root: 'C:\\repo',
    });
  });
});
