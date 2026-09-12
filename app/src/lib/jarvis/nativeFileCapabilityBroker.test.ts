import { describe, expect, it, vi } from 'vitest';
import {
  createNativeFileCapabilityBroker,
  type NativeFileAuthorityPort,
  type NativeFileExecutionScope,
  type NativeFileSnapshot,
} from './nativeFileCapabilityBroker';

async function hash(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

const parameterHash = `sha256:${'a'.repeat(64)}` as const;
const baseScope: NativeFileExecutionScope = {
  accountId: 'account-1',
  projectId: 'project-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
  repositoryRoot: 'C:\\fixture',
  parameterHash,
  now: 100,
};

function execution(operation: 'file.read' | 'file.write' | 'file.delete', requestId: string) {
  const signal = new AbortController().signal;
  return {
    approval: {
      id: `approval-${requestId}`,
      runId: 'run-1',
      requestId,
      attemptNumber: 1,
      capabilityId: 'file.coding',
      actionId: operation,
      actionVersion: 1,
      paramsHash: parameterHash,
      status: 'consumed',
    },
    producerKind: 'file_action',
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
      value: { proofRef: `jlive_${resultRef.slice('jresult_'.length)}` },
    })),
  } as never;
}

async function fixture() {
  const files = new Map<string, string>([['src/auth.ts', 'export const before = true;\n']]);
  const snapshot = async (path: string): Promise<NativeFileSnapshot> => {
    const content = files.get(path);
    return content === undefined
      ? { exists: false, path, content: null, sha256: null, bytes: 0 }
      : {
          exists: true,
          path,
          content,
          sha256: await hash(content),
          bytes: new TextEncoder().encode(content).byteLength,
        };
  };
  let mutationCount = 0;
  const atomicApply = vi.fn<NativeFileAuthorityPort['atomicApply']>(
    async ({ path, expectedBeforeSha256, nextContent }) => {
      mutationCount += 1;
      const before = await snapshot(path);
      if (before.sha256 !== expectedBeforeSha256) throw new Error('compare failed');
      if (nextContent === null) files.delete(path);
      else files.set(path, nextContent);
      return {
        before,
        after: await snapshot(path),
        changedPaths: [path],
        resultRef: `jresult_mutation-${mutationCount}`,
      };
    },
  );
  const port: NativeFileAuthorityPort = {
    resolveRoot: async ({ accountId, projectId, repositoryRoot, ownerId }) => ({
      accountId,
      projectId,
      repositoryRoot,
      rootHandle: 'root-handle-1',
      ownerId,
      platform: 'windows',
      issuedAt: 1,
      expiresAt: 1_000,
      claims: [{ path: 'SRC\\Auth.ts', access: 'write' }],
    }),
    inspect: async () => ({
      entries: [
        {
          path: 'src/auth.ts',
          sha256: await hash(files.get('src/auth.ts')!),
          bytes: new TextEncoder().encode(files.get('src/auth.ts')!).byteLength,
        },
      ],
      resultRef: 'jresult_inspect-1',
    }),
    read: async ({ path }) => snapshot(path),
    atomicApply,
  };
  return { broker: createNativeFileCapabilityBroker(port), files, atomicApply, port };
}

describe('native file capability broker', () => {
  it('inspects only exact claimed fixture paths through issued native authority', async () => {
    const { broker } = await fixture();
    const result = await broker.inspect(
      baseScope,
      execution('file.read', baseScope.requestId),
    );
    expect(result).toMatchObject({
      entries: [{ path: 'src/auth.ts', sha256: expect.stringMatching(/^sha256:/) }],
      resultRef: 'jresult_inspect-1',
      evidenceRef: 'jlive_inspect-1',
    });
  });

  it('previews, atomically applies, independently verifies, and exactly rolls back', async () => {
    const { broker, files, atomicApply } = await fixture();
    const before = await hash(files.get('src/auth.ts')!);
    const nextContent = 'export const after = true;\n';
    const preview = await broker.preview({
      scope: baseScope,
      path: 'src/auth.ts',
      operation: 'modify',
      baseSha256: before,
      nextContent,
      execution: execution('file.read', 'request-1'),
    });
    expect(files.get('src/auth.ts')).not.toBe(nextContent);
    expect(preview).toMatchObject({
      path: 'src/auth.ts',
      baseSha256: before,
      resultSha256: await hash(nextContent),
      changedPaths: ['src/auth.ts'],
    });

    const applyScope = { ...baseScope, requestId: 'request-2', now: 200 };
    const applied = await broker.apply({
      scope: applyScope,
      preview,
      execution: execution('file.write', 'request-2'),
    });
    expect(files.get('src/auth.ts')).toBe(nextContent);
    expect(applied).toMatchObject({
      beforeSha256: before,
      afterSha256: await hash(nextContent),
      changedPaths: ['src/auth.ts'],
    });

    const rollbackScope = { ...baseScope, requestId: 'request-3', now: 300 };
    const rolledBack = await broker.rollback({
      scope: rollbackScope,
      preview,
      applied,
      execution: execution('file.write', 'request-3'),
    });
    expect(files.get('src/auth.ts')).toBe('export const before = true;\n');
    expect(rolledBack.restoredSha256).toBe(before);
    expect(atomicApply).toHaveBeenCalledTimes(2);
  });

  it('rejects stale bases, escaping paths, missing claims, and replay without mutation', async () => {
    const { broker, atomicApply } = await fixture();
    await expect(
      broker.preview({
        scope: baseScope,
        path: '../outside.ts',
        operation: 'modify',
        baseSha256: `sha256:${'b'.repeat(64)}`,
        nextContent: 'changed',
        execution: execution('file.read', 'request-1'),
      }),
    ).rejects.toThrow(/escapes|invalid/i);
    await expect(
      broker.preview({
        scope: baseScope,
        path: 'src/other.ts',
        operation: 'create',
        baseSha256: null,
        nextContent: 'changed',
        execution: execution('file.read', 'request-1'),
      }),
    ).rejects.toThrow(/claim/i);
    await expect(
      broker.preview({
        scope: baseScope,
        path: 'src/auth.ts',
        operation: 'modify',
        baseSha256: `sha256:${'b'.repeat(64)}`,
        nextContent: 'changed',
        execution: execution('file.read', 'request-1'),
      }),
    ).rejects.toThrow(/stale/i);
    expect(atomicApply).not.toHaveBeenCalled();
  });

  it('rejects authority receipts whose observed hashes or changed paths are false', async () => {
    const { broker, port } = await fixture();
    const before = await hash('export const before = true;\n');
    const preview = await broker.preview({
      scope: baseScope,
      path: 'src/auth.ts',
      operation: 'modify',
      baseSha256: before,
      nextContent: 'changed',
      execution: execution('file.read', 'request-1'),
    });
    port.atomicApply = async ({ path }) => ({
      before: {
        exists: true,
        path,
        content: 'wrong',
        sha256: before,
        bytes: 5,
      },
      after: {
        exists: true,
        path,
        content: 'changed',
        sha256: await hash('changed'),
        bytes: 7,
      },
      changedPaths: ['src/other.ts'],
      resultRef: 'jresult_false-evidence',
    });
    await expect(
      broker.apply({
        scope: { ...baseScope, requestId: 'request-2' },
        preview,
        execution: execution('file.write', 'request-2'),
      }),
    ).rejects.toThrow(/evidence/i);
  });
});
