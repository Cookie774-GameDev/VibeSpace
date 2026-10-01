import type { JarvisIssuedActionExecution } from './approvalEngine';
import {
  createNativeCapabilityBroker,
  type NativeCapabilityRequest,
} from './nativeCapabilityBroker';

const MAX_PATH_LENGTH = 1_024;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_INSPECT_ENTRIES = 200;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const EVIDENCE_REF = /^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

export type NativeFileOperation = 'create' | 'modify' | 'delete';

export type NativeFileRootLease = Readonly<{
  accountId: string;
  projectId: string;
  repositoryRoot: string;
  rootHandle: string;
  ownerId: string;
  platform: 'windows' | 'posix';
  issuedAt: number;
  expiresAt: number;
  claims: readonly Readonly<{ path: string; access: 'read' | 'write' }>[];
}>;

export type NativeFileExecutionScope = Readonly<{
  accountId: string;
  projectId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  repositoryRoot: string;
  parameterHash: string;
  now: number;
}>;

export type NativeFileSnapshot = Readonly<{
  exists: boolean;
  path: string;
  content: string | null;
  sha256: `sha256:${string}` | null;
  bytes: number;
}>;

export type NativeFilePatchPreview = Readonly<{
  schemaVersion: 1;
  id: string;
  accountId: string;
  projectId: string;
  runId: string;
  rootHandle: string;
  path: string;
  operation: NativeFileOperation;
  baseSha256: `sha256:${string}` | null;
  resultSha256: `sha256:${string}` | null;
  previousContent: string | null;
  nextContent: string | null;
  changedPaths: readonly string[];
  artifactRef: `jartifact_${string}`;
  createdAt: number;
}>;

export type NativeFileMutationReceipt = Readonly<{
  previewId: string;
  path: string;
  operation: NativeFileOperation;
  beforeSha256: `sha256:${string}` | null;
  afterSha256: `sha256:${string}` | null;
  changedPaths: readonly string[];
  resultRef: `jresult_${string}`;
  evidenceRef: `jlive_${string}`;
  rollbackArtifactRef: `jartifact_${string}`;
  appliedAt: number;
}>;

export type NativeFileRollbackReceipt = Readonly<{
  previewId: string;
  path: string;
  restoredSha256: `sha256:${string}` | null;
  changedPaths: readonly string[];
  resultRef: `jresult_${string}`;
  evidenceRef: `jlive_${string}`;
  artifactRef: `jartifact_${string}`;
  rolledBackAt: number;
}>;

export interface NativeFileAuthorityPort {
  resolveRoot(input: {
    accountId: string;
    projectId: string;
    repositoryRoot: string;
    ownerId: string;
    now: number;
  }): Promise<NativeFileRootLease | null>;
  inspect(input: {
    rootHandle: string;
    maximumEntries: number;
    signal: AbortSignal;
  }): Promise<
    Readonly<{
      entries: readonly Readonly<{
        path: string;
        sha256: `sha256:${string}`;
        bytes: number;
      }>[];
      resultRef: `jresult_${string}`;
    }>
  >;
  read(input: {
    rootHandle: string;
    path: string;
    maximumBytes: number;
    signal: AbortSignal;
  }): Promise<NativeFileSnapshot>;
  atomicApply(input: {
    rootHandle: string;
    path: string;
    expectedBeforeSha256: `sha256:${string}` | null;
    nextContent: string | null;
    maximumBytes: number;
    signal: AbortSignal;
  }): Promise<
    Readonly<{
      before: NativeFileSnapshot;
      after: NativeFileSnapshot;
      changedPaths: readonly string[];
      resultRef: `jresult_${string}`;
    }>
  >;
}

export interface NativeFileCapabilityBroker {
  inspect(
    scope: NativeFileExecutionScope,
    execution: JarvisIssuedActionExecution,
  ): Promise<
    Readonly<{
      entries: readonly Readonly<{ path: string; sha256: string; bytes: number }>[];
      resultRef: string;
      evidenceRef: string;
    }>
  >;
  preview(input: {
    scope: NativeFileExecutionScope;
    path: string;
    operation: NativeFileOperation;
    baseSha256: `sha256:${string}` | null;
    nextContent: string | null;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeFilePatchPreview>;
  apply(input: {
    scope: NativeFileExecutionScope;
    preview: NativeFilePatchPreview;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeFileMutationReceipt>;
  rollback(input: {
    scope: NativeFileExecutionScope;
    preview: NativeFilePatchPreview;
    applied: NativeFileMutationReceipt;
    execution: JarvisIssuedActionExecution;
  }): Promise<NativeFileRollbackReceipt>;
}

function normalizePath(path: string, platform: NativeFileRootLease['platform']): string {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > MAX_PATH_LENGTH ||
    path.trim() !== path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.startsWith('\\\\') ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error('Invalid repository-relative file path.');
  }
  const segments = path.replace(/\\/gu, '/').normalize('NFKC').split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' '),
    )
  ) {
    throw new Error('Repository path escapes its canonical root.');
  }
  const normalized = segments.join('/');
  return platform === 'windows' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function sha256(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function assertSnapshot(
  snapshot: NativeFileSnapshot,
  expectedPath: string,
  maximumBytes: number,
): void {
  if (
    snapshot.path !== expectedPath ||
    !Number.isSafeInteger(snapshot.bytes) ||
    snapshot.bytes < 0 ||
    snapshot.bytes > maximumBytes ||
    (snapshot.exists &&
      (typeof snapshot.content !== 'string' ||
        !snapshot.sha256 ||
        !SHA256.test(snapshot.sha256) ||
        bytes(snapshot.content) !== snapshot.bytes)) ||
    (!snapshot.exists &&
      (snapshot.content !== null || snapshot.sha256 !== null || snapshot.bytes !== 0))
  ) {
    throw new Error('Native file authority returned invalid evidence.');
  }
}

function scopeRequest(
  scope: NativeFileExecutionScope,
  operation: 'file.read' | 'file.write' | 'file.delete',
): NativeCapabilityRequest {
  if (
    !SAFE_ID.test(scope.accountId) ||
    !SAFE_ID.test(scope.projectId) ||
    !SAFE_ID.test(scope.runId) ||
    !SAFE_ID.test(scope.requestId) ||
    !Number.isSafeInteger(scope.attemptNumber) ||
    scope.attemptNumber < 1 ||
    !scope.repositoryRoot ||
    !SHA256.test(scope.parameterHash) ||
    !Number.isSafeInteger(scope.now) ||
    scope.now < 0
  ) {
    throw new Error('Invalid native file execution scope.');
  }
  return {
    capabilityId: 'file.coding',
    capabilityVersion: 1,
    kind: 'file',
    operation,
    accountId: scope.accountId,
    runId: scope.runId,
    requestId: scope.requestId,
    attemptNumber: scope.attemptNumber,
    workspaceRoot: scope.repositoryRoot,
    parameterHash: scope.parameterHash,
  };
}

async function leaseFor(
  port: NativeFileAuthorityPort,
  scope: NativeFileExecutionScope,
  execution: JarvisIssuedActionExecution,
): Promise<NativeFileRootLease> {
  const lease = await port.resolveRoot({
    accountId: scope.accountId,
    projectId: scope.projectId,
    repositoryRoot: scope.repositoryRoot,
    ownerId: execution.ownerId,
    now: scope.now,
  });
  if (
    !lease ||
    lease.accountId !== scope.accountId ||
    lease.projectId !== scope.projectId ||
    lease.repositoryRoot !== scope.repositoryRoot ||
    lease.ownerId !== execution.ownerId ||
    !lease.rootHandle ||
    (lease.platform !== 'windows' && lease.platform !== 'posix') ||
    !Array.isArray(lease.claims) ||
    lease.claims.length > 500 ||
    !Number.isSafeInteger(lease.issuedAt) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.issuedAt < 0 ||
    lease.expiresAt <= lease.issuedAt ||
    scope.now < lease.issuedAt ||
    scope.now >= lease.expiresAt
  ) {
    throw new Error('Matching live native file root authority is required.');
  }
  return lease;
}

function assertClaim(lease: NativeFileRootLease, path: string, access: 'read' | 'write'): string {
  const normalized = normalizePath(path, lease.platform);
  const claim = lease.claims.find(
    (candidate) =>
      normalizePath(candidate.path, lease.platform) === normalized &&
      (candidate.access === access || (access === 'read' && candidate.access === 'write')),
  );
  if (!claim) throw new Error('Exact native file claim is required.');
  return normalized;
}

function brokerFor(
  request: NativeCapabilityRequest,
  execution: JarvisIssuedActionExecution,
  execute: (signal: AbortSignal) => Promise<Readonly<{ resultRef: `jresult_${string}` }>>,
) {
  let adapterError: unknown;
  const broker = createNativeCapabilityBroker({
    verifyIssuedRequest: (candidate, issued) =>
      issued === execution &&
      candidate.accountId === request.accountId &&
      candidate.runId === request.runId &&
      candidate.requestId === request.requestId &&
      candidate.attemptNumber === request.attemptNumber,
  });
  broker.register({
    id: request.capabilityId,
    version: request.capabilityVersion,
    kind: 'file',
    operations: [request.operation],
    risk: request.operation === 'file.read' ? 'read-only' : 'safe-write',
    approval: request.operation === 'file.read' ? 'never' : 'always',
    producerKinds: ['file_action'],
    async execute({ signal }) {
      try {
        const result = await execute(signal);
        return { state: 'completed', resultRef: result.resultRef };
      } catch (error) {
        adapterError = error;
        throw error;
      }
    },
  });
  return Object.freeze({
    async execute() {
      const outcome = await broker.execute(request, execution);
      if (adapterError !== undefined) {
        if (adapterError instanceof Error) throw adapterError;
        throw new Error('Native file adapter failed before canonical evidence.');
      }
      return outcome;
    },
  });
}

function assertCanonicalOutcome(
  outcome: Readonly<{
    state: string;
    resultRef: string;
    evidenceRef: string;
  }>,
  expectedResultRef: string,
): void {
  if (
    outcome.state !== 'completed' ||
    outcome.resultRef !== expectedResultRef ||
    !RESULT_REF.test(outcome.resultRef) ||
    !EVIDENCE_REF.test(outcome.evidenceRef)
  ) {
    throw new Error('Native file capability returned invalid canonical evidence.');
  }
}

export function createNativeFileCapabilityBroker(
  port: NativeFileAuthorityPort,
): NativeFileCapabilityBroker {
  const issuedPreviews = new WeakSet<object>();
  const consumedPreviews = new WeakSet<object>();
  const consumedMutations = new WeakSet<object>();

  const capabilityBroker: NativeFileCapabilityBroker = {
    async inspect(scope, execution) {
      const lease = await leaseFor(port, scope, execution);
      const request = scopeRequest(scope, 'file.read');
      let captured: Awaited<ReturnType<NativeFileAuthorityPort['inspect']>> | undefined;
      const broker = brokerFor(request, execution, async (signal) => {
        captured = await port.inspect({
          rootHandle: lease.rootHandle,
          maximumEntries: MAX_INSPECT_ENTRIES,
          signal,
        });
        if (captured.entries.length > MAX_INSPECT_ENTRIES) {
          throw new Error('Native repository inspection exceeded its entry limit.');
        }
        const paths = new Set<string>();
        for (const entry of captured.entries) {
          const path = assertClaim(lease, entry.path, 'read');
          if (
            paths.has(path) ||
            !SHA256.test(entry.sha256) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0
          ) {
            throw new Error('Invalid native repository inspection evidence.');
          }
          paths.add(path);
        }
        return captured;
      });
      const outcome = await broker.execute();
      if (!captured) throw new Error('Native repository inspection was not captured.');
      assertCanonicalOutcome(outcome, captured.resultRef);
      return Object.freeze({
        entries: Object.freeze(captured.entries.map((entry) => Object.freeze({ ...entry }))),
        resultRef: outcome.resultRef,
        evidenceRef: outcome.evidenceRef,
      });
    },

    async preview(input) {
      const lease = await leaseFor(port, input.scope, input.execution);
      const path = assertClaim(lease, input.path, 'write');
      const request = scopeRequest(input.scope, 'file.read');
      if (
        (input.baseSha256 !== null && !SHA256.test(input.baseSha256)) ||
        (input.nextContent !== null && bytes(input.nextContent) > MAX_PATCH_BYTES) ||
        (input.operation === 'create' &&
          (input.baseSha256 !== null || input.nextContent === null)) ||
        (input.operation === 'modify' &&
          (input.baseSha256 === null || input.nextContent === null)) ||
        (input.operation === 'delete' &&
          (input.baseSha256 === null || input.nextContent !== null))
      ) {
        throw new Error('Invalid exact-base native file patch.');
      }
      let snapshot: NativeFileSnapshot | undefined;
      const broker = brokerFor(request, input.execution, async (signal) => {
        snapshot = await port.read({
          rootHandle: lease.rootHandle,
          path,
          maximumBytes: MAX_PATCH_BYTES,
          signal,
        });
        assertSnapshot(snapshot, path, MAX_PATCH_BYTES);
        if (snapshot.exists && (await sha256(snapshot.content!)) !== snapshot.sha256) {
          throw new Error('Native file base hash evidence mismatch.');
        }
        const actualBase = snapshot.sha256;
        if (
          actualBase !== input.baseSha256 ||
          (input.operation === 'create' && snapshot.exists) ||
          (input.operation !== 'create' && !snapshot.exists)
        ) {
          throw new Error('Native file patch base is stale.');
        }
        return { resultRef: `jresult_file_preview_${input.scope.requestId}` as const };
      });
      const outcome = await broker.execute();
      if (!snapshot) throw new Error('Native file preview was not captured.');
      assertCanonicalOutcome(outcome, `jresult_file_preview_${input.scope.requestId}`);
      const resultSha256 =
        input.nextContent === null ? null : await sha256(input.nextContent);
      const preview = Object.freeze({
        schemaVersion: 1 as const,
        id: `patch-${input.scope.requestId}`,
        accountId: input.scope.accountId,
        projectId: input.scope.projectId,
        runId: input.scope.runId,
        rootHandle: lease.rootHandle,
        path,
        operation: input.operation,
        baseSha256: snapshot.sha256,
        resultSha256,
        previousContent: snapshot.content,
        nextContent: input.nextContent,
        changedPaths: Object.freeze([path]),
        artifactRef: `jartifact_patch_preview_${outcome.evidenceRef.slice('jlive_'.length)}` as const,
        createdAt: input.scope.now,
      });
      issuedPreviews.add(preview);
      return preview;
    },

    async apply(input) {
      if (
        !issuedPreviews.has(input.preview as object) ||
        consumedPreviews.has(input.preview as object) ||
        input.preview.accountId !== input.scope.accountId ||
        input.preview.projectId !== input.scope.projectId ||
        input.preview.runId !== input.scope.runId
      ) {
        throw new Error('Matching unused native file patch preview is required.');
      }
      const lease = await leaseFor(port, input.scope, input.execution);
      const path = assertClaim(lease, input.preview.path, 'write');
      if (input.preview.rootHandle !== lease.rootHandle || path !== input.preview.path) {
        throw new Error('Native file patch root scope changed.');
      }
      const operation =
        input.preview.operation === 'delete' ? 'file.delete' : 'file.write';
      const request = scopeRequest(input.scope, operation);
      let mutation: Awaited<ReturnType<NativeFileAuthorityPort['atomicApply']>> | undefined;
      const broker = brokerFor(request, input.execution, async (signal) => {
        mutation = await port.atomicApply({
          rootHandle: lease.rootHandle,
          path,
          expectedBeforeSha256: input.preview.baseSha256,
          nextContent: input.preview.nextContent,
          maximumBytes: MAX_PATCH_BYTES,
          signal,
        });
        assertSnapshot(mutation.before, path, MAX_PATCH_BYTES);
        assertSnapshot(mutation.after, path, MAX_PATCH_BYTES);
        if (
          mutation.changedPaths.length !== 1 ||
          normalizePath(mutation.changedPaths[0]!, lease.platform) !== path ||
          mutation.before.sha256 !== input.preview.baseSha256 ||
          mutation.after.sha256 !== input.preview.resultSha256 ||
          (mutation.before.exists &&
            (await sha256(mutation.before.content!)) !== mutation.before.sha256) ||
          (mutation.after.exists &&
            (await sha256(mutation.after.content!)) !== mutation.after.sha256)
        ) {
          throw new Error('Native file mutation evidence mismatch.');
        }
        return mutation;
      });
      consumedPreviews.add(input.preview as object);
      const outcome = await broker.execute();
      if (!mutation) throw new Error('Native file mutation was not captured.');
      assertCanonicalOutcome(outcome, mutation.resultRef);
      const receipt = Object.freeze({
        previewId: input.preview.id,
        path,
        operation: input.preview.operation,
        beforeSha256: mutation.before.sha256,
        afterSha256: mutation.after.sha256,
        changedPaths: Object.freeze([path]),
        resultRef: outcome.resultRef,
        evidenceRef: outcome.evidenceRef,
        rollbackArtifactRef: `jartifact_rollback_${outcome.evidenceRef.slice('jlive_'.length)}` as const,
        appliedAt: input.scope.now,
      });
      consumedMutations.add(receipt);
      return receipt;
    },

    async rollback(input) {
      if (
        !issuedPreviews.has(input.preview as object) ||
        !consumedMutations.has(input.applied as object) ||
        input.applied.previewId !== input.preview.id ||
        input.preview.accountId !== input.scope.accountId ||
        input.preview.projectId !== input.scope.projectId ||
        input.preview.runId !== input.scope.runId
      ) {
        throw new Error('Matching applied native file patch is required for rollback.');
      }
      const lease = await leaseFor(port, input.scope, input.execution);
      const path = assertClaim(lease, input.preview.path, 'write');
      const operation =
        input.preview.previousContent === null ? 'file.delete' : 'file.write';
      const request = scopeRequest(input.scope, operation);
      let mutation: Awaited<ReturnType<NativeFileAuthorityPort['atomicApply']>> | undefined;
      const broker = brokerFor(request, input.execution, async (signal) => {
        mutation = await port.atomicApply({
          rootHandle: lease.rootHandle,
          path,
          expectedBeforeSha256: input.preview.resultSha256,
          nextContent: input.preview.previousContent,
          maximumBytes: MAX_PATCH_BYTES,
          signal,
        });
        assertSnapshot(mutation.before, path, MAX_PATCH_BYTES);
        assertSnapshot(mutation.after, path, MAX_PATCH_BYTES);
        if (
          mutation.changedPaths.length !== 1 ||
          normalizePath(mutation.changedPaths[0]!, lease.platform) !== path ||
          mutation.before.sha256 !== input.preview.resultSha256 ||
          mutation.after.sha256 !== input.preview.baseSha256 ||
          (mutation.before.exists &&
            (await sha256(mutation.before.content!)) !== mutation.before.sha256) ||
          (mutation.after.exists &&
            (await sha256(mutation.after.content!)) !== input.preview.baseSha256)
        ) {
          throw new Error('Native file rollback evidence mismatch.');
        }
        return mutation;
      });
      consumedMutations.delete(input.applied as object);
      const outcome = await broker.execute();
      if (!mutation) throw new Error('Native file rollback was not captured.');
      assertCanonicalOutcome(outcome, mutation.resultRef);
      return Object.freeze({
        previewId: input.preview.id,
        path,
        restoredSha256: mutation.after.sha256,
        changedPaths: Object.freeze([path]),
        resultRef: outcome.resultRef,
        evidenceRef: outcome.evidenceRef,
        artifactRef: input.applied.rollbackArtifactRef,
        rolledBackAt: input.scope.now,
      });
    },
  };
  return Object.freeze(capabilityBroker);
}
