import { describe, expect, it } from 'vitest';
import {
  auditCodingRunCompletion,
  createCodingRunManifest,
  type CodingRunManifestV1,
} from './codingRunManifest';

const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

function completeManifest(): CodingRunManifestV1 {
  return createCodingRunManifest({
    runId: 'run-1',
    accountId: 'account-1',
    projectId: 'project-1',
    repositoryRoot: 'C:\\fixture',
    repositoryBranch: 'feature/test',
    repositoryCommit: 'a'.repeat(40),
    contextMapRevision: 3,
    selectedSources: [
      {
        id: 'source-1',
        kind: 'repository_symbol',
        locator: 'src/auth.ts:10',
        sha256: hash('a'),
        tokenCost: 42,
        selectionReason: 'Referenced authentication symbol',
      },
    ],
    workItems: [
      {
        id: 'work-1',
        ownerId: 'agent-1',
        objective: 'Repair authentication fixture.',
        status: 'completed',
        dependencyIds: [],
      },
    ],
    fileClaims: [{ path: 'src/auth.ts', ownerId: 'agent-1', access: 'write' }],
    patches: [
      {
        id: 'patch-1',
        path: 'src/auth.ts',
        operation: 'modify',
        baseSha256: hash('b'),
        resultSha256: hash('c'),
        artifactRef: 'jartifact_patch-1',
        appliedAt: 1_100,
      },
    ],
    commands: [
      {
        id: 'command-1',
        executable: 'npm',
        argumentsHash: hash('d'),
        cwd: 'C:\\fixture',
        startedAt: 1_200,
        finishedAt: 1_300,
        exitCode: 0,
        resultRef: 'jresult_command-1',
      },
    ],
    tests: [
      {
        id: 'test-1',
        commandReceiptId: 'command-1',
        status: 'passed',
        resultRef: 'jresult_test-1',
      },
    ],
    approvals: [
      {
        id: 'approval-1',
        capabilityId: 'file.write',
        state: 'approved',
        evidenceRef: 'jlive_approval-1',
      },
    ],
    outputArtifacts: ['jartifact_report-1'],
    checkpointId: 'jcheckpoint_checkpoint-1',
    rollback: [
      {
        patchArtifactId: 'patch-1',
        state: 'available',
        artifactRef: 'jartifact_rollback-1',
        verifiedSha256: hash('b'),
      },
    ],
    createdAt: 1_000,
    updatedAt: 1_400,
  });
}

describe('coding-run manifest', () => {
  it('binds complete coding evidence and passes only after the final mutation', () => {
    const manifest = completeManifest();
    expect(auditCodingRunCompletion(manifest)).toMatchObject({
      ready: true,
      evidenceRefs: expect.arrayContaining([
        'jartifact_patch-1',
        'jresult_test-1',
        'jcheckpoint_checkpoint-1',
        'jartifact_rollback-1',
      ]),
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.patches)).toBe(true);
  });

  it('rejects patches outside exact write claims and conflicting writers', () => {
    const valid = completeManifest();
    const input: Omit<CodingRunManifestV1, 'schemaVersion'> = valid;
    expect(() =>
      createCodingRunManifest({
        ...input,
        patches: [{ ...valid.patches[0]!, path: 'src/outside.ts' }],
      }),
    ).toThrow(/patch artifact/i);
    expect(() =>
      createCodingRunManifest({
        ...input,
        fileClaims: [
          ...valid.fileClaims,
          { path: 'src/auth.ts', ownerId: 'agent-2', access: 'write' },
        ],
      }),
    ).toThrow(/conflicting/i);
  });

  it('canonicalizes Windows claims and rejects traversal and case-colliding writers', () => {
    const valid = completeManifest();
    const input: Omit<CodingRunManifestV1, 'schemaVersion'> = valid;
    expect(
      createCodingRunManifest({
        ...input,
        fileClaims: [{ path: 'SRC\\Auth.ts', ownerId: 'agent-1', access: 'write' }],
        patches: [{ ...valid.patches[0]!, path: 'src/auth.ts' }],
      }).patches[0]?.path,
    ).toBe('src/auth.ts');
    expect(() =>
      createCodingRunManifest({
        ...input,
        fileClaims: [
          { path: 'src/auth.ts', ownerId: 'agent-1', access: 'write' },
          { path: 'SRC\\AUTH.ts', ownerId: 'agent-2', access: 'write' },
        ],
      }),
    ).toThrow(/conflicting/i);
    expect(() =>
      createCodingRunManifest({
        ...input,
        fileClaims: [{ path: '../outside.ts', ownerId: 'agent-1', access: 'write' }],
      }),
    ).toThrow(/claim/i);
  });

  it('refuses truthful completion when work, tests, approval, checkpoint, or rollback is missing', () => {
    const valid = completeManifest();
    const input: Omit<CodingRunManifestV1, 'schemaVersion'> = valid;
    const incomplete = createCodingRunManifest({
      ...input,
      workItems: [{ ...valid.workItems[0]!, status: 'running' }],
      patches: [{ ...valid.patches[0]!, appliedAt: null }],
      tests: [{ ...valid.tests[0]!, status: 'failed' }],
      approvals: [{ ...valid.approvals[0]!, state: 'denied' }],
      checkpointId: null,
      rollback: [],
    });
    expect(auditCodingRunCompletion(incomplete)).toEqual({
      ready: false,
      reasons: [
        'approval_unresolved',
        'checkpoint_missing',
        'patch_unapplied',
        'rollback_missing',
        'test_failed',
        'work_incomplete',
      ],
    });
  });

  it('does not report completion after a rollback has been applied', () => {
    const valid = completeManifest();
    const input: Omit<CodingRunManifestV1, 'schemaVersion'> = valid;
    const rolledBack = createCodingRunManifest({
      ...input,
      rollback: [{ ...valid.rollback[0]!, state: 'applied' }],
    });
    expect(auditCodingRunCompletion(rolledBack)).toEqual({
      ready: false,
      reasons: ['patch_unverified'],
    });
  });

  it('rejects persisted enum values that only masquerade as typed evidence', () => {
    const valid = completeManifest();
    const input: Omit<CodingRunManifestV1, 'schemaVersion'> = valid;
    expect(() =>
      createCodingRunManifest({
        ...input,
        approvals: [{ ...valid.approvals[0]!, state: 'unknown' as never }],
      }),
    ).toThrow(/approval/i);
  });
});
