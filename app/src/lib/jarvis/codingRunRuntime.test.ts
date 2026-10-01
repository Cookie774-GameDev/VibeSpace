import { describe, expect, it, vi } from 'vitest';
import type { JarvisIssuedActionExecution } from './approvalEngine';
import { createCodingRunManifest } from './codingRunManifest';
import { createCodingRunRuntime } from './codingRunRuntime';
import { createGoalCheckpointRepository } from './goalCheckpointRepository';
import type {
  NativeFileCapabilityBroker,
  NativeFileMutationReceipt,
  NativeFilePatchPreview,
} from './nativeFileCapabilityBroker';

const baseHash = `sha256:${'a'.repeat(64)}` as const;
const resultHash = `sha256:${'b'.repeat(64)}` as const;
const argumentsHash = `sha256:${'c'.repeat(64)}` as const;

function issued(
  capabilityId: 'file.coding' | 'terminal.coding_test',
  actionId: string,
  requestId: string,
  paramsHash = argumentsHash,
): JarvisIssuedActionExecution {
  const signal = new AbortController().signal;
  return {
    approval: {
      id: `approval-${requestId}`,
      accountId: 'account-1',
      runId: 'run-1',
      requestId,
      attemptNumber: 1,
      capabilityId,
      actionId,
      actionVersion: 1,
      paramsHash,
      status: 'consumed',
    },
    producerKind: capabilityId === 'file.coding' ? 'file_action' : 'terminal',
    ownerId: 'agent-1',
    initialLiveProof: {
      accountId: 'account-1',
      runId: 'run-1',
      requestId,
      attemptNumber: 1,
      proofRef: `jlive_start-${requestId}`,
    },
    beginExternalEffect: vi.fn((begin) => ({
      kind: 'committed',
      value: begin(signal),
    })),
    recordResult: vi.fn(async ({ resultRef }) => ({
      kind: 'committed',
      value: { proofRef: `jlive_recorded-${resultRef.slice('jresult_'.length)}` },
    })),
  } as never;
}

function fixture() {
  const preview = Object.freeze({
    schemaVersion: 1 as const,
    id: 'patch-request-1',
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    rootHandle: 'root-1',
    path: 'src/auth.ts',
    operation: 'modify' as const,
    baseSha256: baseHash,
    resultSha256: resultHash,
    previousContent: 'before',
    nextContent: 'after',
    changedPaths: Object.freeze(['src/auth.ts']),
    artifactRef: 'jartifact_patch-preview-1' as const,
    createdAt: 200,
  }) satisfies NativeFilePatchPreview;
  const applied = Object.freeze({
    previewId: preview.id,
    path: preview.path,
    operation: preview.operation,
    beforeSha256: baseHash,
    afterSha256: resultHash,
    changedPaths: Object.freeze(['src/auth.ts']),
    resultRef: 'jresult_patch-apply-1' as const,
    evidenceRef: 'jlive_patch-apply-1' as const,
    rollbackArtifactRef: 'jartifact_rollback-1' as const,
    appliedAt: 300,
  }) satisfies NativeFileMutationReceipt;
  const fileBroker: NativeFileCapabilityBroker = {
    inspect: vi.fn(async () => ({
      entries: [{ path: preview.path, sha256: baseHash, bytes: 6 }],
      resultRef: 'jresult_inspect-1',
      evidenceRef: 'jlive_inspect-1',
    })),
    preview: vi.fn(async () => preview),
    apply: vi.fn(async () => applied),
    rollback: vi.fn(async () => ({
      previewId: preview.id,
      path: preview.path,
      restoredSha256: baseHash,
      changedPaths: Object.freeze(['src/auth.ts']),
      resultRef: 'jresult_patch-rollback-1' as const,
      evidenceRef: 'jlive_patch-rollback-1' as const,
      artifactRef: applied.rollbackArtifactRef,
      rolledBackAt: 600,
    })),
  };
  const records: unknown[] = [];
  const checkpoints = createGoalCheckpointRepository({
    loadScope: async () => records,
    appendExpected: async ({ record }) => {
      records.push(record);
      return { kind: 'appended', record };
    },
  });
  const tests = {
    execute: vi.fn(async () => ({
      command: {
        id: 'command-1',
        executable: 'npm',
        argumentsHash,
        cwd: 'C:\\fixture',
        startedAt: 350,
        finishedAt: 400,
        exitCode: 0,
        resultRef: 'jresult_command-1',
      },
      test: {
        id: 'test-1',
        commandReceiptId: 'command-1',
        status: 'passed' as const,
        resultRef: 'jresult_test-1',
      },
    })),
  };
  const runtime = createCodingRunRuntime({
    manifest: createCodingRunManifest({
      runId: 'run-1',
      accountId: 'account-1',
      projectId: 'project-1',
      repositoryRoot: 'C:\\fixture',
      repositoryBranch: 'feature/test',
      repositoryCommit: 'd'.repeat(40),
      contextMapRevision: 7,
      selectedSources: [
        {
          id: 'source-1',
          kind: 'repository_file',
          locator: 'src/auth.ts',
          sha256: baseHash,
          tokenCost: 10,
          selectionReason: 'Owned fixture file.',
        },
      ],
      workItems: [
        {
          id: 'work-1',
          ownerId: 'agent-1',
          objective: 'Update the fixture safely.',
          status: 'completed',
          dependencyIds: [],
        },
      ],
      fileClaims: [{ path: 'SRC\\Auth.ts', ownerId: 'agent-1', access: 'write' }],
      patches: [],
      commands: [],
      tests: [],
      approvals: [],
      outputArtifacts: [],
      checkpointId: null,
      rollback: [],
      createdAt: 100,
      updatedAt: 100,
    }),
    fileBroker,
    checkpoints,
    tests,
    authorityVersion: 1,
  });
  return { runtime, preview, applied, fileBroker, tests };
}

describe('coding run runtime', () => {
  it('binds preview, mutation, focused verification, checkpoint, and resume evidence', async () => {
    const { runtime, preview, tests } = fixture();
    const previewed = await runtime.preview({
      scope: {} as never,
      path: 'src/auth.ts',
      operation: 'modify',
      baseSha256: baseHash,
      nextContent: 'after',
      execution: issued('file.coding', 'file.read', 'request-1'),
    });
    await runtime.apply({
      scope: {} as never,
      preview: previewed,
      execution: issued('file.coding', 'file.write', 'request-2'),
    });
    const testExecution = issued('terminal.coding_test', 'coding.test', 'request-test');
    await runtime.runTest({
      plan: {
        id: 'test-1',
        executable: 'npm',
        argumentsHash,
        cwd: 'C:\\fixture',
      },
      execution: testExecution,
    });
    expect(tests.execute).toHaveBeenCalledTimes(1);
    expect(testExecution.beginExternalEffect).toHaveBeenCalledTimes(1);
    expect(runtime.manifest()).toMatchObject({
      patches: [{ id: preview.id, baseSha256: baseHash, resultSha256: resultHash }],
      tests: [{ id: 'test-1', status: 'passed' }],
      rollback: [{ patchArtifactId: preview.id, state: 'available' }],
      contextMapRevision: 8,
    });

    const record = await runtime.checkpoint({
      previous: null,
      now: 500,
      cursorExpiresAt: 1_000,
    });
    const current = {
      accountId: 'account-1',
      projectId: 'project-1',
      repoRoot: 'C:\\fixture',
      branch: 'feature/test',
      headSha: 'd'.repeat(40),
      authorityVersion: 1,
      latestCheckpointSequence: 1,
      now: 550,
    };
    expect(() => runtime.resume(record, current)).not.toThrow();
    expect(() =>
      runtime.resume(record, { ...current, latestCheckpointSequence: 2 }),
    ).toThrow(/checkpoint_stale/i);
    expect(runtime.completion()).toMatchObject({ ready: true });
  });

  it('marks completion unverified after exact rollback and rejects replay', async () => {
    const { runtime } = fixture();
    const previewed = await runtime.preview({
      scope: {} as never,
      path: 'src/auth.ts',
      operation: 'modify',
      baseSha256: baseHash,
      nextContent: 'after',
      execution: issued('file.coding', 'file.read', 'request-1'),
    });
    const applied = await runtime.apply({
      scope: {} as never,
      preview: previewed,
      execution: issued('file.coding', 'file.write', 'request-2'),
    });
    const rollbackInput = {
      scope: {} as never,
      preview: previewed,
      applied,
      execution: issued('file.coding', 'file.write', 'request-3'),
    };
    await runtime.rollback(rollbackInput);
    expect(runtime.manifest().contextMapRevision).toBe(9);
    expect(runtime.completion()).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(['patch_unverified']),
    });
    await expect(runtime.rollback(rollbackInput)).rejects.toThrow(/unavailable/i);
  });
});
