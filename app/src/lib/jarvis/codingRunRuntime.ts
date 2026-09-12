import type { JarvisIssuedActionExecution } from './approvalEngine';
import {
  auditCodingRunCompletion,
  createCodingRunManifest,
  type CodingRunCommandReceipt,
  type CodingRunManifestV1,
  type CodingRunTestReceipt,
} from './codingRunManifest';
import {
  createGoalManifest,
  type GoalManifestV1,
  type GoalResumeCurrentAuthority,
} from './goalCheckpoint';
import type {
  GoalCheckpointRepository,
  GoalCheckpointStoredRecordV1,
} from './goalCheckpointRepository';
import type {
  NativeFileCapabilityBroker,
  NativeFileExecutionScope,
  NativeFileMutationReceipt,
  NativeFilePatchPreview,
} from './nativeFileCapabilityBroker';

export type CodingTestPlan = Readonly<{
  id: string;
  executable: string;
  argumentsHash: `sha256:${string}`;
  cwd: string;
}>;

export interface CodingTestAuthority {
  execute(input: {
    accountId: string;
    projectId: string;
    runId: string;
    plan: CodingTestPlan;
    signal: AbortSignal;
  }): Promise<
    Readonly<{
      command: CodingRunCommandReceipt;
      test: CodingRunTestReceipt;
    }>
  >;
}

export interface CodingRunRuntime {
  manifest(): CodingRunManifestV1;
  inspect(
    scope: NativeFileExecutionScope,
    execution: JarvisIssuedActionExecution,
  ): ReturnType<NativeFileCapabilityBroker['inspect']>;
  preview(input: {
    scope: NativeFileExecutionScope;
    path: string;
    operation: 'create' | 'modify' | 'delete';
    baseSha256: `sha256:${string}` | null;
    nextContent: string | null;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeFilePatchPreview>;
  apply(input: {
    scope: NativeFileExecutionScope;
    preview: NativeFilePatchPreview;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeFileMutationReceipt>;
  runTest(input: {
    plan: CodingTestPlan;
    execution: JarvisIssuedActionExecution;
  }): Promise<Readonly<{ command: CodingRunCommandReceipt; test: CodingRunTestReceipt }>>;
  checkpoint(input: {
    previous: GoalCheckpointStoredRecordV1 | null;
    now: number;
    cursorExpiresAt: number;
  }): Promise<GoalCheckpointStoredRecordV1>;
  resume(
    record: GoalCheckpointStoredRecordV1,
    current: GoalResumeCurrentAuthority,
  ): void;
  rollback(input: {
    scope: NativeFileExecutionScope;
    preview: NativeFilePatchPreview;
    applied: NativeFileMutationReceipt;
    execution: JarvisIssuedActionExecution;
  }): Promise<void>;
  completion(): ReturnType<typeof auditCodingRunCompletion>;
}

function replaceManifest(
  manifest: CodingRunManifestV1,
  updates: Partial<Omit<CodingRunManifestV1, 'schemaVersion'>>,
): CodingRunManifestV1 {
  const { schemaVersion: _schemaVersion, ...input } = manifest;
  return createCodingRunManifest({ ...input, ...updates });
}

function manifestHasWriteClaim(manifest: CodingRunManifestV1, path: string): boolean {
  const windows =
    /^[A-Za-z]:\\/u.test(manifest.repositoryRoot) ||
    manifest.repositoryRoot.startsWith('\\\\');
  const canonicalPath = windows ? path.toLocaleLowerCase('en-US') : path;
  return manifest.fileClaims.some(
    (claim) =>
      claim.access === 'write' &&
      (windows
        ? claim.path.replace(/\\/gu, '/').toLocaleLowerCase('en-US')
        : claim.path) === canonicalPath,
  );
}

function goalManifestFor(
  manifest: CodingRunManifestV1,
  authorityVersion: number,
  expiresAt: number,
): GoalManifestV1 {
  return createGoalManifest({
    id: `coding-goal-${manifest.runId}`,
    accountId: manifest.accountId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    repoRoot: manifest.repositoryRoot,
    branch: manifest.repositoryBranch,
    headSha: manifest.repositoryCommit,
    objective: manifest.workItems.map(({ objective }) => objective).join(' ') || 'Complete coding run.',
    criteria: [
      {
        id: 'coding_run_complete',
        description: 'Coding run has verified patches, tests, approvals, checkpoint, and rollback.',
        mandatory: true,
      },
    ],
    ownership: {
      ownedPaths: manifest.fileClaims.map(({ path }) => path),
      exclusions: [],
    },
    authorityVersion,
    issuedAt: manifest.createdAt,
    expiresAt,
  });
}

function exactIssuedTest(
  manifest: CodingRunManifestV1,
  plan: CodingTestPlan,
  execution: JarvisIssuedActionExecution,
): void {
  const { approval, initialLiveProof } = execution;
  if (
    approval.status !== 'consumed' ||
    execution.producerKind !== 'terminal' ||
    approval.capabilityId !== 'terminal.coding_test' ||
    approval.actionId !== 'coding.test' ||
    approval.actionVersion !== 1 ||
    approval.runId !== manifest.runId ||
    approval.requestId !== initialLiveProof.requestId ||
    approval.attemptNumber !== initialLiveProof.attemptNumber ||
    approval.paramsHash !== plan.argumentsHash ||
    initialLiveProof.accountId !== manifest.accountId ||
    initialLiveProof.runId !== manifest.runId ||
    !plan.id ||
    !plan.executable ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.argumentsHash) ||
    plan.cwd !== manifest.repositoryRoot
  ) {
    throw new Error('Matching issued coding-test execution is required.');
  }
}

export function createCodingRunRuntime(input: {
  manifest: CodingRunManifestV1;
  fileBroker: NativeFileCapabilityBroker;
  checkpoints: GoalCheckpointRepository;
  tests: CodingTestAuthority;
  authorityVersion: number;
}): CodingRunRuntime {
  let manifest = createCodingRunManifest(input.manifest);
  const previews = new Map<string, NativeFilePatchPreview>();
  const applied = new Map<string, NativeFileMutationReceipt>();
  const claimedTests = new WeakSet<object>();

  const runtime: CodingRunRuntime = {
    manifest: () => manifest,
    inspect(scope, execution) {
      return input.fileBroker.inspect(scope, execution);
    },
    async preview(previewInput) {
      const preview = await input.fileBroker.preview(previewInput);
      if (!manifestHasWriteClaim(manifest, preview.path)) {
        throw new Error('Coding-run manifest does not claim the previewed path.');
      }
      previews.set(preview.id, preview);
      return preview;
    },
    async apply(applyInput) {
      if (previews.get(applyInput.preview.id) !== applyInput.preview) {
        throw new Error('Coding-run patch preview is unavailable.');
      }
      if (manifest.contextMapRevision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Coding-run context revision is exhausted.');
      }
      const receipt = await input.fileBroker.apply(applyInput);
      applied.set(applyInput.preview.id, receipt);
      const patches = manifest.patches.filter(({ id }) => id !== applyInput.preview.id);
      patches.push({
        id: applyInput.preview.id,
        path: receipt.path,
        operation: receipt.operation,
        baseSha256: receipt.beforeSha256,
        resultSha256: receipt.afterSha256,
        artifactRef: applyInput.preview.artifactRef,
        appliedAt: receipt.appliedAt,
      });
      const rollback = manifest.rollback.filter(
        ({ patchArtifactId }) => patchArtifactId !== applyInput.preview.id,
      );
      rollback.push({
        patchArtifactId: applyInput.preview.id,
        state: 'available',
        artifactRef: receipt.rollbackArtifactRef,
        verifiedSha256: receipt.beforeSha256,
      });
      manifest = replaceManifest(manifest, {
        patches,
        rollback,
        approvals: [
          ...manifest.approvals.filter(({ id }) => id !== applyInput.execution.approval.id),
          {
            id: applyInput.execution.approval.id,
            capabilityId: applyInput.execution.approval.capabilityId,
            state: 'approved',
            evidenceRef: applyInput.execution.initialLiveProof.proofRef,
          },
        ],
        outputArtifacts: [...new Set([...manifest.outputArtifacts, receipt.resultRef])],
        contextMapRevision: manifest.contextMapRevision + 1,
        updatedAt: Math.max(manifest.updatedAt, receipt.appliedAt),
      });
      return receipt;
    },
    async runTest({ plan, execution }) {
      exactIssuedTest(manifest, plan, execution);
      if (claimedTests.has(execution as object)) {
        throw new Error('Issued coding-test execution has already been claimed.');
      }
      claimedTests.add(execution as object);
      const started = execution.beginExternalEffect((signal) => ({
        completion: input.tests.execute({
          accountId: manifest.accountId,
          projectId: manifest.projectId,
          runId: manifest.runId,
          plan: Object.freeze({ ...plan }),
          signal,
        }),
      }));
      if (started.kind !== 'committed') {
        throw new Error('Coding-test authority was revoked before execution.');
      }
      const result = await started.value.completion;
      if (
        result.command.id !== result.test.commandReceiptId ||
        result.command.executable !== plan.executable ||
        result.command.argumentsHash !== plan.argumentsHash ||
        result.command.cwd !== plan.cwd ||
        result.test.id !== plan.id ||
        result.test.status === 'skipped' ||
        (result.test.status === 'passed' && result.command.exitCode !== 0) ||
        (result.test.status === 'failed' && result.command.exitCode === 0)
      ) {
        throw new Error('Coding-test authority returned mismatched evidence.');
      }
      const recorded = await execution.recordResult({
        state: result.test.status === 'passed' ? 'completed' : 'degraded',
        resultRef: result.test.resultRef,
        completedAt: result.command.finishedAt,
      });
      if (recorded.kind !== 'committed') {
        throw new Error('Coding-test result authority was revoked before recording.');
      }
      manifest = replaceManifest(manifest, {
        commands: [
          ...manifest.commands.filter(({ id }) => id !== result.command.id),
          result.command,
        ],
        tests: [...manifest.tests.filter(({ id }) => id !== result.test.id), result.test],
        approvals: [
          ...manifest.approvals.filter(({ id }) => id !== execution.approval.id),
          {
            id: execution.approval.id,
            capabilityId: execution.approval.capabilityId,
            state: 'approved',
            evidenceRef: recorded.value.proofRef,
          },
        ],
        updatedAt: Math.max(manifest.updatedAt, result.command.finishedAt),
      });
      return Object.freeze(result);
    },
    async checkpoint({ previous, now, cursorExpiresAt }) {
      const goal = goalManifestFor(manifest, input.authorityVersion, cursorExpiresAt);
      if (
        previous &&
        (previous.accountId !== manifest.accountId ||
          previous.projectId !== manifest.projectId ||
          previous.manifest.runId !== manifest.runId)
      ) {
        throw new Error('Coding checkpoint scope mismatch.');
      }
      const completion = auditCodingRunCompletion(manifest);
      const readyWithoutCheckpoint =
        !completion.ready &&
        completion.reasons.length === 1 &&
        completion.reasons[0] === 'checkpoint_missing';
      const state = completion.ready || readyWithoutCheckpoint ? 'ready_for_completion' : 'running';
      const evidenceRefs = [
        ...new Set(
          [
            ...manifest.commands.map(({ resultRef }) => resultRef),
            ...manifest.tests.map(({ resultRef }) => resultRef),
            ...manifest.approvals.map(({ evidenceRef }) => evidenceRef),
          ].filter((ref) => /^j(?:result|live)_/u.test(ref)),
        ),
      ];
      const result = await input.checkpoints.append({
        manifest: goal,
        previous,
        expectedRevision: previous?.revision ?? 0,
        idempotencyKey: `coding-checkpoint-${manifest.runId}-${(previous?.revision ?? 0) + 1}`,
        state,
        completedCriteriaIds: state === 'ready_for_completion' ? ['coding_run_complete'] : [],
        evidenceRefs,
        finalMutationAt: Math.max(
          manifest.createdAt,
          ...manifest.patches.map(({ appliedAt }) => appliedAt ?? manifest.createdAt),
        ),
        createdAt: now,
        cursorIssuedAt: now,
        cursorExpiresAt,
      });
      if (result.kind === 'conflict') throw new Error('Coding checkpoint revision conflict.');
      const record = result.record;
      manifest = replaceManifest(manifest, {
        checkpointId: `jcheckpoint_${manifest.runId}_${record.revision}`,
        updatedAt: Math.max(manifest.updatedAt, now),
      });
      return record;
    },
    resume(record, current) {
      if (
        record.accountId !== manifest.accountId ||
        record.projectId !== manifest.projectId ||
        record.manifest.runId !== manifest.runId ||
        record.manifest.repoRoot !== manifest.repositoryRoot ||
        record.manifest.branch !== manifest.repositoryBranch ||
        record.manifest.headSha !== manifest.repositoryCommit
      ) {
        throw new Error('Coding resume scope mismatch.');
      }
      const validation = input.checkpoints.validateResume(record, current);
      if (!validation.ok) throw new Error(`Coding resume rejected: ${validation.reason}.`);
    },
    async rollback(rollbackInput) {
      if (
        previews.get(rollbackInput.preview.id) !== rollbackInput.preview ||
        applied.get(rollbackInput.preview.id) !== rollbackInput.applied
      ) {
        throw new Error('Coding rollback evidence is unavailable.');
      }
      if (manifest.contextMapRevision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Coding-run context revision is exhausted.');
      }
      const receipt = await input.fileBroker.rollback(rollbackInput);
      applied.delete(rollbackInput.preview.id);
      manifest = replaceManifest(manifest, {
        rollback: [
          ...manifest.rollback.filter(
            ({ patchArtifactId }) => patchArtifactId !== rollbackInput.preview.id,
          ),
          {
            patchArtifactId: rollbackInput.preview.id,
            state: 'applied',
            artifactRef: receipt.artifactRef,
            verifiedSha256: receipt.restoredSha256,
          },
        ],
        outputArtifacts: [...new Set([...manifest.outputArtifacts, receipt.resultRef])],
        contextMapRevision: manifest.contextMapRevision + 1,
        updatedAt: Math.max(manifest.updatedAt, receipt.rolledBackAt),
      });
    },
    completion() {
      return auditCodingRunCompletion(manifest);
    },
  };
  return Object.freeze(runtime);
}
