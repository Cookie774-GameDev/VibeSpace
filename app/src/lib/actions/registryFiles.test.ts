import { describe, expect, it } from 'vitest';
import type { CanonicalFileActionEvidence } from '@/lib/jarvis/artifactProducerAdapters';
import { getBuiltinAction } from './registry';
import { isCanonicalFileArtifactResult } from './registryFiles';

describe('retired VibeSpace file and arbitrary shell actions', () => {
  it('keeps file I/O and arbitrary shell executors out of the built-in registry', () => {
    for (const id of [
      'files.read',
      'files.create',
      'files.edit',
      'terminal.run',
      'terminal.powershell',
      'custom.createTerminalCommand',
    ]) {
      expect(getBuiltinAction(id), `${id} is not a public VibeSpace action`).toBeUndefined();
    }
    for (const id of ['file.search', 'terminal.start_cli', 'terminal.sendToRefs', 'terminal.sendAll']) {
      expect(getBuiltinAction(id), `${id} remains available`).toBeDefined();
    }
  });
});

describe('canonical file artifact result truth', () => {
  const evidence = Object.freeze({
    producerId: 'file_action_result',
    accountId: 'account-file',
    runId: 'jrun_file',
    requestId: 'jrequest_file',
    attemptNumber: 1,
    resultRef: 'jresult_file',
    state: 'succeeded',
    verifiedAt: 1_786_202_100_000,
    actionId: 'files.create',
    actionVersion: 1,
  }) satisfies CanonicalFileActionEvidence;

  it('accepts only persisted create, edit, read, and explicit partial results', () => {
    expect(
      isCanonicalFileArtifactResult(evidence, {
        ok: true,
        summary: 'Created.',
        data: {
          path: 'C:\\Projects\\FarmLife\\created.md',
          operation: 'create',
          contentSha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 7,
        },
      }),
    ).toBe(true);
    expect(
      isCanonicalFileArtifactResult(Object.freeze({ ...evidence, actionId: 'files.edit' }), {
        ok: true,
        summary: 'Updated.',
        data: { path: 'C:\\Projects\\FarmLife\\updated.md', operation: 'edit' },
      }),
    ).toBe(true);
    expect(
      isCanonicalFileArtifactResult(Object.freeze({ ...evidence, actionId: 'files.read' }), {
        ok: true,
        summary: 'Read.',
        data: { path: 'C:\\Projects\\FarmLife\\read.md', content: 'verified bytes' },
      }),
    ).toBe(true);
    expect(
      isCanonicalFileArtifactResult(Object.freeze({ ...evidence, state: 'partial' }), {
        ok: true,
        summary: 'Partial.',
        data: { partial: true, blobKey: 'blob-file-part-1' },
      }),
    ).toBe(true);
  });

  it('rejects proposals, requests, mismatched operations, and failed action results', () => {
    for (const result of [
      { ok: true as const, summary: 'Proposed.', data: { proposedPath: 'future.md' } },
      { ok: true as const, summary: 'Requested.', data: { requestedPath: 'future.md' } },
      {
        ok: true as const,
        summary: 'Wrong operation.',
        data: { path: 'created.md', operation: 'edit' },
      },
      { ok: false as const, error: 'write failed' },
    ]) {
      expect(isCanonicalFileArtifactResult(evidence, result)).toBe(false);
    }
  });

  it('accepts only exact persisted patch and rollback receipts', () => {
    const patchEvidence = Object.freeze({
      ...evidence,
      actionId: 'files.patch.apply',
    });
    const receipt = {
      path: 'src/auth.ts',
      operation: 'modify',
      beforeSha256: `sha256:${'a'.repeat(64)}`,
      afterSha256: `sha256:${'b'.repeat(64)}`,
      changedPaths: ['src/auth.ts'],
      previewId: 'patch-request-1',
      rollbackArtifactRef: 'jartifact_rollback-1',
    };
    expect(
      isCanonicalFileArtifactResult(patchEvidence, {
        ok: true,
        summary: 'Applied.',
        data: receipt,
      }),
    ).toBe(true);
    expect(
      isCanonicalFileArtifactResult(
        Object.freeze({ ...patchEvidence, actionId: 'files.patch.rollback' }),
        {
          ok: true,
          summary: 'Rolled back.',
          data: {
            path: 'src/auth.ts',
            changedPaths: ['src/auth.ts'],
            previewId: 'patch-request-1',
            artifactRef: 'jartifact_rollback-1',
            restoredSha256: `sha256:${'c'.repeat(64)}`,
          },
        },
      ),
    ).toBe(true);
  });
});