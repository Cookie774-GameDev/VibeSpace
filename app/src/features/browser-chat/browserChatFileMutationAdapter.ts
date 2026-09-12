import {
  compareAndSwapTextFile,
  readTextFileWithSha256,
  sha256Text,
  type FsHashedTextResult,
  type FsTextMutationResult,
} from '@/lib/fs';
import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import { hasDetectedSecret } from '@/lib/security/secretDetector';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import {
  BrowserChatFileAdapterError,
  resolveBrowserChatFilePath,
  type BrowserChatResolvedFilePath,
} from './browserChatFileAdapter';
import type {
  BrowserChatCapabilityId,
  BrowserChatCapabilityLease,
  BrowserChatOperation,
} from './permissionRegistry';

const MAX_MUTATION_BYTES = 256 * 1_024;
const PREVIEW_TTL_MS = 5 * 60_000;
const UNDO_TTL_MS = 15 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{11,95}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export type BrowserChatFileMutationOperation = 'create' | 'modify' | 'delete';

export type BrowserChatFileMutationPreview = Readonly<{
  id: string;
  operation: BrowserChatFileMutationOperation;
  path: string;
  beforeSha256: `sha256:${string}` | null;
  afterSha256: `sha256:${string}` | null;
  beforeBytes: number;
  afterBytes: number;
  change: Readonly<{
    changedBeforeLines: number;
    changedAfterLines: number;
  }>;
  createdAt: number;
  expiresAt: number;
}>;

export type BrowserChatFileMutationReceipt = Readonly<{
  previewId: string;
  operation: BrowserChatFileMutationOperation;
  path: string;
  beforeSha256: `sha256:${string}` | null;
  afterSha256: `sha256:${string}` | null;
  beforeBytes: number;
  afterBytes: number;
  undoId: string;
  undoExpiresAt: number;
  appliedAt: number;
}>;

export type BrowserChatFileUndoReceipt = Readonly<{
  undoId: string;
  operation: BrowserChatFileMutationOperation;
  path: string;
  restoredSha256: `sha256:${string}` | null;
  restoredBytes: number;
  undoneAt: number;
}>;

export type BrowserChatFileMutationErrorCode =
  | 'path_invalid'
  | 'sensitive_path_blocked'
  | 'content_invalid'
  | 'sensitive_content_blocked'
  | 'already_exists'
  | 'not_found'
  | 'capability_mismatch'
  | 'preview_invalid'
  | 'preview_expired'
  | 'preview_replayed'
  | 'undo_invalid'
  | 'undo_expired'
  | 'undo_replayed'
  | 'stale_base'
  | 'native_denied'
  | 'result_invalid';

export class BrowserChatFileMutationError extends Error {
  constructor(
    readonly code: BrowserChatFileMutationErrorCode,
    readonly nativeCode?: string,
  ) {
    super(`Browser Chat file mutation rejected: ${code}.`);
    this.name = 'BrowserChatFileMutationError';
  }
}

type StrictRootOptions = Readonly<{ root: string; strictProjectBoundary: true }>;

export interface BrowserChatFileMutationDependencies {
  readTextFileWithSha256(
    path: string,
    maxBytes: number,
    options: StrictRootOptions,
  ): Promise<FsHashedTextResult>;
  compareAndSwapTextFile(
    path: string,
    expectedSha256: `sha256:${string}` | null,
    nextContent: string | null,
    options: Readonly<{ root: string }>,
  ): Promise<FsTextMutationResult>;
}

export interface BrowserChatFileMutationAdapter {
  preview(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly operation: BrowserChatFileMutationOperation;
    readonly path: string;
    readonly content?: string;
    readonly now?: number;
  }): Promise<BrowserChatFileMutationPreview>;
  apply(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly preview: BrowserChatFileMutationPreview;
    readonly now?: number;
  }): Promise<BrowserChatFileMutationReceipt>;
  undo(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly undoId: string;
    readonly now?: number;
  }): Promise<BrowserChatFileUndoReceipt>;
  revoke(): void;
}

type AdapterOptions = Readonly<{
  root: string;
  approvalBroker: BrowserChatApprovalBroker;
  dependencies?: BrowserChatFileMutationDependencies;
  allowSensitivePaths?: boolean;
  allowSensitiveContent?: boolean;
  previewIdFactory?: () => string;
  undoIdFactory?: () => string;
}>;

type PreviewState = {
  path: BrowserChatResolvedFilePath;
  previousContent: string | null;
  nextContent: string | null;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type UndoState = {
  operation: BrowserChatFileMutationOperation;
  path: BrowserChatResolvedFilePath;
  expectedSha256: `sha256:${string}` | null;
  expectedBytes: number;
  restoredSha256: `sha256:${string}` | null;
  restoredContent: string | null;
  restoredBytes: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

function capabilityFor(operation: BrowserChatFileMutationOperation): BrowserChatCapabilityId {
  if (operation === 'create') return 'files.create';
  if (operation === 'modify') return 'files.modify';
  return 'files.delete';
}

function undoCapabilityFor(operation: BrowserChatFileMutationOperation): BrowserChatCapabilityId {
  if (operation === 'create') return 'files.delete';
  if (operation === 'delete') return 'files.create';
  return 'files.modify';
}

function assertCapability(
  lease: BrowserChatCapabilityLease,
  capabilityId: BrowserChatCapabilityId,
): void {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatFileMutationError('capability_mismatch');
  }
}

function lineChange(before: string | null, after: string | null) {
  const beforeLines = before ? before.split(/\r?\n/u) : [];
  const afterLines = after ? after.split(/\r?\n/u) : [];
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return Object.freeze({
    changedBeforeLines: beforeLines.length - prefix - suffix,
    changedAfterLines: afterLines.length - prefix - suffix,
  });
}

function bytes(content: string | null): number {
  return content === null ? 0 : new TextEncoder().encode(content).byteLength;
}

function validateContent(
  operation: BrowserChatFileMutationOperation,
  content: string | undefined,
  allowSensitiveContent: boolean,
): string | null {
  if (operation === 'delete') {
    if (content !== undefined) throw new BrowserChatFileMutationError('content_invalid');
    return null;
  }
  if (
    typeof content !== 'string' ||
    content.includes('\u0000') ||
    content.includes('\uFFFD') ||
    bytes(content) > MAX_MUTATION_BYTES
  ) {
    throw new BrowserChatFileMutationError('content_invalid');
  }
  if (!allowSensitiveContent && hasDetectedSecret(content)) {
    throw new BrowserChatFileMutationError('sensitive_content_blocked');
  }
  return content;
}

async function safeNative<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new BrowserChatFileMutationError('native_denied');
  }
}

function nativeMutationFailure(result: Extract<FsTextMutationResult, { ok: false }>): never {
  if (result.error.code === 'stale_base') {
    throw new BrowserChatFileMutationError('stale_base');
  }
  if (result.error.code === 'already_exists') {
    throw new BrowserChatFileMutationError('already_exists');
  }
  if (result.error.code === 'not_found') {
    throw new BrowserChatFileMutationError('not_found');
  }
  throw new BrowserChatFileMutationError('native_denied', result.error.code);
}

function beginOperation(
  broker: BrowserChatApprovalBroker,
  lease: BrowserChatCapabilityLease,
  capabilityId: BrowserChatCapabilityId,
  now: number,
): BrowserChatOperation {
  assertCapability(lease, capabilityId);
  return broker.begin(lease, { now });
}

export function createBrowserChatFileMutationAdapter(
  options: AdapterOptions,
): BrowserChatFileMutationAdapter {
  const normalizedRoot = normalizePortableAbsolutePath(options.root);
  if (!normalizedRoot) throw new BrowserChatFileMutationError('path_invalid');
  const root: string = normalizedRoot;
  const dependencies: BrowserChatFileMutationDependencies = options.dependencies ?? {
    readTextFileWithSha256,
    compareAndSwapTextFile,
  };
  const allowSensitivePaths = options.allowSensitivePaths === true;
  const allowSensitiveContent = options.allowSensitiveContent === true;
  const previewIdFactory = options.previewIdFactory ?? (() => crypto.randomUUID());
  const undoIdFactory = options.undoIdFactory ?? (() => crypto.randomUUID());
  const strictOptions = Object.freeze({ root, strictProjectBoundary: true as const });
  const previewStates = new Map<object, PreviewState>();
  const previewIds = new Set<string>();
  const consumedPreviews = new WeakSet<object>();
  const undoStates = new Map<string, UndoState>();
  const consumedUndo = new Set<string>();

  function releasePreview(preview: object): void {
    const state = previewStates.get(preview);
    if (!state) return;
    clearTimeout(state.timer);
    previewStates.delete(preview);
    const id = (preview as { readonly id?: unknown }).id;
    if (typeof id === 'string') previewIds.delete(id);
  }

  function releaseUndo(undoId: string): void {
    const state = undoStates.get(undoId);
    if (!state) return;
    clearTimeout(state.timer);
    undoStates.delete(undoId);
  }

  function resolvePath(path: string): BrowserChatResolvedFilePath {
    try {
      return resolveBrowserChatFilePath(path, root, allowSensitivePaths);
    } catch (error) {
      if (
        error instanceof BrowserChatFileAdapterError &&
        (error.code === 'path_invalid' || error.code === 'sensitive_path_blocked')
      ) {
        throw new BrowserChatFileMutationError(error.code);
      }
      throw new BrowserChatFileMutationError('path_invalid');
    }
  }

  async function readExisting(path: BrowserChatResolvedFilePath) {
    const result = await safeNative(() =>
      dependencies.readTextFileWithSha256(path.absolute, MAX_MUTATION_BYTES, strictOptions),
    );
    if (!result.ok) {
      if (result.error.code === 'not_found') {
        throw new BrowserChatFileMutationError('not_found');
      }
      throw new BrowserChatFileMutationError('native_denied', result.error.code);
    }
    if (
      result.path !== path.absolute ||
      !SHA256.test(result.sha256) ||
      result.bytes !== bytes(result.content) ||
      (await sha256Text(result.content)) !== result.sha256
    ) {
      throw new BrowserChatFileMutationError('result_invalid');
    }
    return result;
  }

  function validateMutationReceipt(
    result: Extract<FsTextMutationResult, { ok: true }>,
    path: BrowserChatResolvedFilePath,
    beforeSha256: `sha256:${string}` | null,
    afterSha256: `sha256:${string}` | null,
    beforeBytes: number,
    afterBytes: number,
  ): void {
    if (
      result.path !== path.absolute ||
      result.beforeSha256 !== beforeSha256 ||
      result.afterSha256 !== afterSha256 ||
      result.beforeBytes !== beforeBytes ||
      result.afterBytes !== afterBytes
    ) {
      throw new BrowserChatFileMutationError('result_invalid');
    }
  }

  const adapter: BrowserChatFileMutationAdapter = {
    async preview(input) {
      const path = resolvePath(input.path);
      const nextContent = validateContent(input.operation, input.content, allowSensitiveContent);
      const now = input.now ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new BrowserChatFileMutationError('preview_invalid');
      }
      const readOperation = beginOperation(options.approvalBroker, input.lease, 'files.read', now);
      try {
        if (readOperation.signal.aborted) {
          throw new BrowserChatFileMutationError('native_denied', 'operation_cancelled');
        }
        let previousContent: string | null = null;
        let beforeSha256: `sha256:${string}` | null = null;
        let beforeBytes = 0;

        if (input.operation === 'create') {
          const existing = await safeNative(() =>
            dependencies.readTextFileWithSha256(path.absolute, MAX_MUTATION_BYTES, strictOptions),
          );
          if (existing.ok) throw new BrowserChatFileMutationError('already_exists');
          if (existing.error.code !== 'not_found') {
            throw new BrowserChatFileMutationError('native_denied', existing.error.code);
          }
        } else {
          const existing = await readExisting(path);
          previousContent = existing.content;
          beforeSha256 = existing.sha256;
          beforeBytes = existing.bytes;
        }

        const afterSha256 = nextContent === null ? null : await sha256Text(nextContent);
        const previewId = previewIdFactory();
        if (!SAFE_ID.test(previewId) || previewIds.has(previewId)) {
          throw new BrowserChatFileMutationError('preview_invalid');
        }
        const preview = Object.freeze({
          id: previewId,
          operation: input.operation,
          path: path.relative,
          beforeSha256,
          afterSha256,
          beforeBytes,
          afterBytes: bytes(nextContent),
          change: lineChange(previousContent, nextContent),
          createdAt: now,
          expiresAt: now + PREVIEW_TTL_MS,
        });
        previewStates.set(preview, {
          path,
          previousContent,
          nextContent,
          expiresAt: preview.expiresAt,
          timer: setTimeout(() => releasePreview(preview), PREVIEW_TTL_MS),
        });
        previewIds.add(previewId);
        return preview;
      } finally {
        readOperation.finish();
      }
    },

    async apply(input) {
      if (consumedPreviews.has(input.preview as object)) {
        throw new BrowserChatFileMutationError('preview_replayed');
      }
      const state = previewStates.get(input.preview as object);
      if (!state) throw new BrowserChatFileMutationError('preview_invalid');
      const now = input.now ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new BrowserChatFileMutationError('preview_invalid');
      }
      if (state.expiresAt <= now) {
        releasePreview(input.preview as object);
        throw new BrowserChatFileMutationError('preview_expired');
      }
      const capabilityId = capabilityFor(input.preview.operation);
      const operation = beginOperation(options.approvalBroker, input.lease, capabilityId, now);
      const undoId = undoIdFactory();
      if (!SAFE_ID.test(undoId) || undoStates.has(undoId) || consumedUndo.has(undoId)) {
        operation.finish();
        throw new BrowserChatFileMutationError('result_invalid');
      }
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatFileMutationError('native_denied', 'operation_cancelled');
        }
        const result = await safeNative(() =>
          dependencies.compareAndSwapTextFile(
            state.path.absolute,
            input.preview.beforeSha256,
            state.nextContent,
            { root },
          ),
        );
        if (!result.ok) nativeMutationFailure(result);
        validateMutationReceipt(
          result,
          state.path,
          input.preview.beforeSha256,
          input.preview.afterSha256,
          input.preview.beforeBytes,
          input.preview.afterBytes,
        );
        releasePreview(input.preview as object);
        consumedPreviews.add(input.preview as object);
        const undoExpiresAt = now + UNDO_TTL_MS;
        undoStates.set(undoId, {
          operation: input.preview.operation,
          path: state.path,
          expectedSha256: input.preview.afterSha256,
          expectedBytes: input.preview.afterBytes,
          restoredSha256: input.preview.beforeSha256,
          restoredContent: state.previousContent,
          restoredBytes: input.preview.beforeBytes,
          expiresAt: undoExpiresAt,
          timer: setTimeout(() => releaseUndo(undoId), UNDO_TTL_MS),
        });
        return Object.freeze({
          previewId: input.preview.id,
          operation: input.preview.operation,
          path: input.preview.path,
          beforeSha256: input.preview.beforeSha256,
          afterSha256: input.preview.afterSha256,
          beforeBytes: input.preview.beforeBytes,
          afterBytes: input.preview.afterBytes,
          undoId,
          undoExpiresAt,
          appliedAt: now,
        });
      } finally {
        operation.finish();
      }
    },

    async undo(input) {
      if (!SAFE_ID.test(input.undoId)) {
        throw new BrowserChatFileMutationError('undo_invalid');
      }
      if (consumedUndo.has(input.undoId)) {
        throw new BrowserChatFileMutationError('undo_replayed');
      }
      const state = undoStates.get(input.undoId);
      if (!state) throw new BrowserChatFileMutationError('undo_invalid');
      const now = input.now ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new BrowserChatFileMutationError('undo_invalid');
      }
      if (state.expiresAt <= now) {
        releaseUndo(input.undoId);
        throw new BrowserChatFileMutationError('undo_expired');
      }
      const operation = beginOperation(
        options.approvalBroker,
        input.lease,
        undoCapabilityFor(state.operation),
        now,
      );
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatFileMutationError('native_denied', 'operation_cancelled');
        }
        const result = await safeNative(() =>
          dependencies.compareAndSwapTextFile(
            state.path.absolute,
            state.expectedSha256,
            state.restoredContent,
            { root },
          ),
        );
        if (!result.ok) nativeMutationFailure(result);
        validateMutationReceipt(
          result,
          state.path,
          state.expectedSha256,
          state.restoredSha256,
          state.expectedBytes,
          state.restoredBytes,
        );
        consumedUndo.add(input.undoId);
        releaseUndo(input.undoId);
        return Object.freeze({
          undoId: input.undoId,
          operation: state.operation,
          path: state.path.relative,
          restoredSha256: state.restoredSha256,
          restoredBytes: state.restoredBytes,
          undoneAt: now,
        });
      } finally {
        operation.finish();
      }
    },

    revoke() {
      for (const preview of previewStates.keys()) releasePreview(preview);
      for (const undoId of undoStates.keys()) releaseUndo(undoId);
      previewIds.clear();
      consumedUndo.clear();
    },
  };
  return Object.freeze(adapter);
}
