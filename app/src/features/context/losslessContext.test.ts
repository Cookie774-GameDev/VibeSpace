import { describe, expect, it } from 'vitest';
import {
  ContextContractError,
  createContextPointer,
  createContextRecord,
  pointerBounds,
} from './losslessContext';

const HASH_A = 'a'.repeat(64);

describe('lossless context contracts', () => {
  it('preserves immutable source identity, scope, trust, and content authority', () => {
    expect(
      createContextRecord({
        id: 'record-1',
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        sourceKind: 'file_version',
        sourceId: 'file-1@abc123',
        parentSourceId: 'file-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        contentHash: HASH_A,
        contentRef: 'asset://sha256/aaaaaaaa',
        title: 'README.md at abc123',
        path: 'README.md',
        gitCommit: 'abc123',
        trustLevel: 'app_verified',
        sensitivity: 'private',
      }),
    ).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      sourceKind: 'file_version',
      sourceId: 'file-1@abc123',
      contentHash: HASH_A,
      contentRef: 'asset://sha256/aaaaaaaa',
      trustLevel: 'app_verified',
    });
  });

  it('rejects mutable or malformed records instead of silently normalizing them', () => {
    expect(() =>
      createContextRecord({
        id: 'record-1',
        accountId: 'account-1',
        sourceKind: 'file',
        sourceId: 'file-1',
        createdAt: 2,
        updatedAt: 1,
        contentHash: 'not-a-hash',
        contentRef: ' ',
        trustLevel: 'app_verified',
      }),
    ).toThrow(ContextContractError);
  });

  it('creates exact bounded byte or line pointers tied to one source version and hash', () => {
    const bytePointer = createContextPointer({
      id: 'pointer-byte',
      recordId: 'record-1',
      byteStart: 10,
      byteEnd: 20,
      sourceVersion: 'sha256:aaaaaaaa',
      contentHash: HASH_A,
    });
    const linePointer = createContextPointer({
      id: 'pointer-line',
      recordId: 'record-1',
      lineStart: 4,
      lineEnd: 7,
      sourceVersion: 'git:abc123',
      contentHash: HASH_A,
    });

    expect(pointerBounds(bytePointer)).toEqual({ kind: 'bytes', start: 10, end: 20 });
    expect(pointerBounds(linePointer)).toEqual({ kind: 'lines', start: 4, end: 7 });
  });

  it.each([
    {},
    { byteStart: 20, byteEnd: 10 },
    { lineStart: 0, lineEnd: 1 },
    { byteStart: 0, byteEnd: 1, lineStart: 1, lineEnd: 2 },
    { byteStart: 0 },
  ])('rejects an ambiguous or invalid pointer span: %o', (span) => {
    expect(() =>
      createContextPointer({
        id: 'pointer-1',
        recordId: 'record-1',
        sourceVersion: 'sha256:aaaaaaaa',
        contentHash: HASH_A,
        ...span,
      }),
    ).toThrow(ContextContractError);
  });
});
