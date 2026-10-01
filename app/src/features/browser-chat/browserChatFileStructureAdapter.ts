import {
  copyProjectFile,
  createDirectoryWithReceipt,
  moveProjectFileWithReceipt,
  statProjectPath,
  type FsDirectoryResult,
  type FsFileTransferResult,
  type FsPathStatResult,
} from '@/lib/fs';
import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import {
  BrowserChatFileAdapterError,
  resolveBrowserChatFilePath,
  type BrowserChatResolvedFilePath,
} from './browserChatFileAdapter';
import type { BrowserChatCapabilityId, BrowserChatCapabilityLease } from './permissionRegistry';

type StrictRootOptions = Readonly<{ root: string; strictProjectBoundary: true }>;

export interface BrowserChatFileStructureDependencies {
  statProjectPath(
    path: string,
    includeSha256: boolean,
    options: StrictRootOptions,
  ): Promise<FsPathStatResult>;
  createDirectoryWithReceipt(path: string, options: StrictRootOptions): Promise<FsDirectoryResult>;
  copyProjectFile(
    sourcePath: string,
    path: string,
    options: StrictRootOptions,
  ): Promise<FsFileTransferResult>;
  moveProjectFileWithReceipt(
    sourcePath: string,
    path: string,
    options: StrictRootOptions,
  ): Promise<FsFileTransferResult>;
}

export type BrowserChatFileStructureErrorCode =
  | 'path_invalid'
  | 'sensitive_path_blocked'
  | 'capability_mismatch'
  | 'operation_cancelled'
  | 'native_denied'
  | 'result_invalid';

export class BrowserChatFileStructureError extends Error {
  constructor(
    readonly code: BrowserChatFileStructureErrorCode,
    readonly nativeCode?: string,
  ) {
    super(`Browser Chat file structure operation rejected: ${code}.`);
    this.name = 'BrowserChatFileStructureError';
  }
}

export type BrowserChatFileStatResult = Readonly<{
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  createdMs?: number;
  modifiedMs?: number;
  sha256?: `sha256:${string}`;
}>;

export type BrowserChatDirectoryResult = Readonly<{
  path: string;
  created: boolean;
}>;

export type BrowserChatFileTransferResult = Readonly<{
  operation: 'copy' | 'move';
  sourcePath: string;
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
}>;

export interface BrowserChatFileStructureAdapter {
  stat(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly path: string;
    readonly includeSha256?: boolean;
    readonly now?: number;
  }): Promise<BrowserChatFileStatResult>;
  createDirectory(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly path: string;
    readonly now?: number;
  }): Promise<BrowserChatDirectoryResult>;
  copy(input: {
    readonly readLease: BrowserChatCapabilityLease;
    readonly createLease: BrowserChatCapabilityLease;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly now?: number;
  }): Promise<BrowserChatFileTransferResult>;
  move(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly now?: number;
  }): Promise<BrowserChatFileTransferResult>;
}

type AdapterOptions = Readonly<{
  root: string;
  approvalBroker: BrowserChatApprovalBroker;
  dependencies?: BrowserChatFileStructureDependencies;
  allowSensitivePaths?: boolean;
}>;

function assertCapability(
  lease: BrowserChatCapabilityLease,
  capabilityId: BrowserChatCapabilityId,
): void {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatFileStructureError('capability_mismatch');
  }
}

function sameAbsolutePath(left: string, right: string): boolean {
  const normalizedLeft = normalizePortableAbsolutePath(left);
  const normalizedRight = normalizePortableAbsolutePath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const windows =
    /^[A-Za-z]:\\/u.test(normalizedLeft) ||
    /^[A-Za-z]:\\/u.test(normalizedRight) ||
    normalizedLeft.startsWith('\\\\') ||
    normalizedRight.startsWith('\\\\');
  return windows
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function resolvedPath(
  rawPath: string,
  root: string,
  allowSensitivePaths: boolean,
  allowRoot: boolean,
): BrowserChatResolvedFilePath {
  try {
    const path = resolveBrowserChatFilePath(rawPath, root, allowSensitivePaths);
    if (!allowRoot && path.relative === '.') {
      throw new BrowserChatFileStructureError('path_invalid');
    }
    return path;
  } catch (error) {
    if (error instanceof BrowserChatFileStructureError) throw error;
    if (error instanceof BrowserChatFileAdapterError) {
      if (error.code === 'sensitive_path_blocked') {
        throw new BrowserChatFileStructureError('sensitive_path_blocked');
      }
      throw new BrowserChatFileStructureError('path_invalid');
    }
    throw new BrowserChatFileStructureError('path_invalid');
  }
}

function nativeDenied(
  result: Exclude<FsDirectoryResult | FsFileTransferResult | FsPathStatResult, { ok: true }>,
): never {
  throw new BrowserChatFileStructureError('native_denied', result.error.code);
}

async function callNative<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BrowserChatFileStructureError) throw error;
    throw new BrowserChatFileStructureError('native_denied');
  }
}

export function createBrowserChatFileStructureAdapter(
  options: AdapterOptions,
): BrowserChatFileStructureAdapter {
  const root = normalizePortableAbsolutePath(options.root);
  if (!root) throw new BrowserChatFileStructureError('path_invalid');
  const allowSensitivePaths = options.allowSensitivePaths === true;
  const strictOptions = Object.freeze({ root, strictProjectBoundary: true as const });
  const dependencies: BrowserChatFileStructureDependencies = options.dependencies ?? {
    statProjectPath: (path, includeSha256, fsOptions) =>
      statProjectPath(path, includeSha256, fsOptions),
    createDirectoryWithReceipt: (path, fsOptions) => createDirectoryWithReceipt(path, fsOptions),
    copyProjectFile: (sourcePath, path, fsOptions) => copyProjectFile(sourcePath, path, fsOptions),
    moveProjectFileWithReceipt: (sourcePath, path, fsOptions) =>
      moveProjectFileWithReceipt(sourcePath, path, fsOptions),
  };

  function begin(
    lease: BrowserChatCapabilityLease,
    capabilityId: BrowserChatCapabilityId,
    now: number | undefined,
  ) {
    assertCapability(lease, capabilityId);
    return options.approvalBroker.begin(lease, now === undefined ? {} : { now });
  }

  return {
    async stat(input) {
      const path = resolvedPath(input.path, root, allowSensitivePaths, true);
      const includeSha256 = input.includeSha256 === true;
      const operation = begin(input.lease, 'files.read', input.now);
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatFileStructureError('operation_cancelled');
        }
        const result = await callNative(() =>
          dependencies.statProjectPath(path.absolute, includeSha256, strictOptions),
        );
        if (!result.ok) nativeDenied(result);
        if (
          !sameAbsolutePath(result.path, path.absolute) ||
          (includeSha256 && result.kind === 'file' && !result.sha256)
        ) {
          throw new BrowserChatFileStructureError('result_invalid');
        }
        return Object.freeze({
          path: path.relative,
          kind: result.kind,
          ...(result.size === undefined ? {} : { size: result.size }),
          ...(result.createdMs === undefined ? {} : { createdMs: result.createdMs }),
          ...(result.modifiedMs === undefined ? {} : { modifiedMs: result.modifiedMs }),
          ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
        });
      } finally {
        operation.finish();
      }
    },

    async createDirectory(input) {
      const path = resolvedPath(input.path, root, allowSensitivePaths, false);
      const operation = begin(input.lease, 'files.create', input.now);
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatFileStructureError('operation_cancelled');
        }
        const result = await callNative(() =>
          dependencies.createDirectoryWithReceipt(path.absolute, strictOptions),
        );
        if (!result.ok) nativeDenied(result);
        if (!sameAbsolutePath(result.path, path.absolute)) {
          throw new BrowserChatFileStructureError('result_invalid');
        }
        return Object.freeze({ path: path.relative, created: result.created });
      } finally {
        operation.finish();
      }
    },

    async copy(input) {
      const source = resolvedPath(input.sourcePath, root, allowSensitivePaths, false);
      const destination = resolvedPath(input.destinationPath, root, allowSensitivePaths, false);
      if (sameAbsolutePath(source.absolute, destination.absolute)) {
        throw new BrowserChatFileStructureError('path_invalid');
      }
      const readOperation = begin(input.readLease, 'files.read', input.now);
      let createOperation: ReturnType<BrowserChatApprovalBroker['begin']> | undefined;
      try {
        createOperation = begin(input.createLease, 'files.create', input.now);
        if (readOperation.signal.aborted || createOperation.signal.aborted) {
          throw new BrowserChatFileStructureError('operation_cancelled');
        }
        const result = await callNative(() =>
          dependencies.copyProjectFile(source.absolute, destination.absolute, strictOptions),
        );
        if (!result.ok) nativeDenied(result);
        if (
          !sameAbsolutePath(result.sourcePath, source.absolute) ||
          !sameAbsolutePath(result.path, destination.absolute)
        ) {
          throw new BrowserChatFileStructureError('result_invalid');
        }
        return Object.freeze({
          operation: 'copy' as const,
          sourcePath: source.relative,
          path: destination.relative,
          bytes: result.bytes,
          sha256: result.sha256,
        });
      } finally {
        createOperation?.finish();
        readOperation.finish();
      }
    },

    async move(input) {
      const source = resolvedPath(input.sourcePath, root, allowSensitivePaths, false);
      const destination = resolvedPath(input.destinationPath, root, allowSensitivePaths, false);
      if (sameAbsolutePath(source.absolute, destination.absolute)) {
        throw new BrowserChatFileStructureError('path_invalid');
      }
      const operation = begin(input.lease, 'files.move', input.now);
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatFileStructureError('operation_cancelled');
        }
        const result = await callNative(() =>
          dependencies.moveProjectFileWithReceipt(
            source.absolute,
            destination.absolute,
            strictOptions,
          ),
        );
        if (!result.ok) nativeDenied(result);
        if (
          !sameAbsolutePath(result.sourcePath, source.absolute) ||
          !sameAbsolutePath(result.path, destination.absolute)
        ) {
          throw new BrowserChatFileStructureError('result_invalid');
        }
        return Object.freeze({
          operation: 'move' as const,
          sourcePath: source.relative,
          path: destination.relative,
          bytes: result.bytes,
          sha256: result.sha256,
        });
      } finally {
        operation.finish();
      }
    },
  };
}
