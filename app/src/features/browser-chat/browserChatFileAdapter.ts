import { listDirectory, readTextFileSample, type FsListResult, type FsReadResult } from '@/lib/fs';
import { isPathInsideRoot, normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import { applySecretPolicy, type SecretPolicyAction } from '@/lib/security/secretDetector';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import type { BrowserChatCapabilityId, BrowserChatCapabilityLease } from './permissionRegistry';

const MAX_RELATIVE_PATH_LENGTH = 1_024;
const MAX_PATH_SEGMENTS = 24;
const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 48 * 1_024;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_ENTRIES = 2_000;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_MATCHES = 100;
const MAX_QUERY_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 240;

const TEXT_EXTENSIONS = new Set([
  '',
  '.bat',
  '.c',
  '.cc',
  '.cmd',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export type BrowserChatFileAdapterErrorCode =
  | 'path_invalid'
  | 'capability_mismatch'
  | 'query_invalid'
  | 'native_denied'
  | 'sensitive_path_blocked'
  | 'sensitive_content_blocked'
  | 'result_invalid'
  | 'operation_cancelled';

export class BrowserChatFileAdapterError extends Error {
  constructor(
    readonly code: BrowserChatFileAdapterErrorCode,
    readonly nativeCode?: string,
  ) {
    super(`Browser Chat file operation rejected: ${code}.`);
    this.name = 'BrowserChatFileAdapterError';
  }
}

type StrictFsOptions = Readonly<{
  root: string;
  strictProjectBoundary: true;
}>;

export interface BrowserChatFileAdapterDependencies {
  listDirectory(
    path: string,
    options: StrictFsOptions,
    signal?: AbortSignal,
  ): Promise<FsListResult>;
  readTextFileSample(
    path: string,
    maxBytes: number,
    options: StrictFsOptions,
    signal?: AbortSignal,
  ): Promise<FsReadResult>;
}

export type BrowserChatFileListResult = Readonly<{
  path: string;
  entries: readonly Readonly<{
    name: string;
    path: string;
    isDir: boolean;
    size?: number;
  }>[];
  truncated: boolean;
}>;

export type BrowserChatFileReadResult = Readonly<{
  path: string;
  content: string;
  bytes: number;
  redacted: boolean;
}>;

export type BrowserChatFileSearchResult = Readonly<{
  path: string;
  query: string;
  matches: readonly Readonly<{
    path: string;
    line: number;
    snippet: string;
  }>[];
  searchedFiles: number;
  truncated: boolean;
}>;

export interface BrowserChatFileAdapter {
  list(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly path: string;
    readonly now?: number;
  }): Promise<BrowserChatFileListResult>;
  read(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly path: string;
    readonly now?: number;
  }): Promise<BrowserChatFileReadResult>;
  search(input: {
    readonly lease: BrowserChatCapabilityLease;
    readonly path: string;
    readonly query: string;
    readonly now?: number;
  }): Promise<BrowserChatFileSearchResult>;
}

type AdapterOptions = Readonly<{
  root: string;
  approvalBroker: BrowserChatApprovalBroker;
  dependencies?: BrowserChatFileAdapterDependencies;
  sensitiveContentPolicy?: SecretPolicyAction;
  allowSensitivePaths?: boolean;
}>;

export type BrowserChatResolvedFilePath = Readonly<{
  absolute: string;
  relative: string;
}>;

function sensitiveSegment(segment: string): boolean {
  const name = segment.toLocaleLowerCase('en-US');
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'target' ||
    name === '.ssh' ||
    name === '.gnupg' ||
    name === '.aws' ||
    name === '.azure' ||
    name === '.kube' ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === '.netrc'
  );
}

function samePortableAbsolutePath(left: string, right: string): boolean {
  const windows =
    /^[A-Za-z]:\\/u.test(left) ||
    /^[A-Za-z]:\\/u.test(right) ||
    left.startsWith('\\\\') ||
    right.startsWith('\\\\');
  return windows
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

export function resolveBrowserChatFilePath(
  rawPath: string,
  root: string,
  allowSensitivePaths: boolean,
): BrowserChatResolvedFilePath {
  if (
    typeof rawPath !== 'string' ||
    rawPath.length < 1 ||
    rawPath.length > MAX_RELATIVE_PATH_LENGTH ||
    rawPath.trim() !== rawPath ||
    /[\u0000-\u001f\u007f]/u.test(rawPath) ||
    /^[A-Za-z]:[\\/]/u.test(rawPath) ||
    /^[\\/]/u.test(rawPath) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawPath)
  ) {
    throw new BrowserChatFileAdapterError('path_invalid');
  }
  const segments = rawPath
    .replace(/\\/gu, '/')
    .normalize('NFKC')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        segment === '..' || segment.includes(':') || segment.endsWith('.') || segment.endsWith(' '),
    )
  ) {
    throw new BrowserChatFileAdapterError('path_invalid');
  }
  if (!allowSensitivePaths && segments.some(sensitiveSegment)) {
    throw new BrowserChatFileAdapterError('sensitive_path_blocked');
  }
  const separator = root.includes('\\') ? '\\' : '/';
  const candidate =
    segments.length === 0
      ? root
      : `${root.replace(/[\\/]+$/u, '')}${separator}${segments.join(separator)}`;
  const absolute = normalizePortableAbsolutePath(candidate);
  if (!absolute || !isPathInsideRoot(absolute, root)) {
    throw new BrowserChatFileAdapterError('path_invalid');
  }
  return {
    absolute,
    relative: segments.length === 0 ? '.' : segments.join('/'),
  };
}

function resolveListedChild(
  entryPath: string,
  entryName: string,
  parent: BrowserChatResolvedFilePath,
  root: string,
  allowSensitivePaths: boolean,
): BrowserChatResolvedFilePath | null {
  if (
    !entryName ||
    entryName === '.' ||
    entryName === '..' ||
    entryName.includes('/') ||
    entryName.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(entryName)
  ) {
    return null;
  }
  try {
    const expected = resolveBrowserChatFilePath(
      parent.relative === '.' ? entryName : `${parent.relative}/${entryName}`,
      root,
      allowSensitivePaths,
    );
    const reported = normalizePortableAbsolutePath(entryPath);
    return reported && samePortableAbsolutePath(reported, expected.absolute) ? expected : null;
  } catch {
    return null;
  }
}

function extension(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLocaleLowerCase('en-US') : '';
}

function nativeDenied(result: Exclude<FsListResult | FsReadResult, { ok: true }>): never {
  throw new BrowserChatFileAdapterError('native_denied', result.error.code);
}

async function callNative<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BrowserChatFileAdapterError) throw error;
    throw new BrowserChatFileAdapterError('native_denied');
  }
}

function assertMatchingCapability(
  lease: BrowserChatCapabilityLease,
  capabilityId: BrowserChatCapabilityId,
): void {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatFileAdapterError('capability_mismatch');
  }
}

async function raceCancellation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new BrowserChatFileAdapterError('operation_cancelled');
  let rejectCancellation: ((reason: BrowserChatFileAdapterError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () =>
    rejectCancellation?.(new BrowserChatFileAdapterError('operation_cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function safeSnippet(line: string): string {
  const collapsed = line.trim().replace(/\s+/gu, ' ');
  return collapsed.length <= MAX_SNIPPET_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

export function createBrowserChatFileAdapter(options: AdapterOptions): BrowserChatFileAdapter {
  const root = normalizePortableAbsolutePath(options.root);
  if (!root) throw new BrowserChatFileAdapterError('path_invalid');
  const dependencies: BrowserChatFileAdapterDependencies = options.dependencies ?? {
    listDirectory: (path, fsOptions) => listDirectory(path, fsOptions),
    readTextFileSample: (path, maxBytes, fsOptions) =>
      readTextFileSample(path, maxBytes, fsOptions),
  };
  const allowSensitivePaths = options.allowSensitivePaths === true;
  const sensitiveContentPolicy = options.sensitiveContentPolicy ?? 'exclude';
  const strictOptions = Object.freeze({ root, strictProjectBoundary: true as const });

  async function execute<T>(
    capabilityId: BrowserChatCapabilityId,
    lease: BrowserChatCapabilityLease,
    now: number | undefined,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assertMatchingCapability(lease, capabilityId);
    const operation = options.approvalBroker.begin(lease, now === undefined ? {} : { now });
    try {
      return await raceCancellation(task(operation.signal), operation.signal);
    } finally {
      operation.finish();
    }
  }

  async function readSafeText(
    path: BrowserChatResolvedFilePath,
    signal: AbortSignal,
  ): Promise<BrowserChatFileReadResult> {
    const result = await callNative(() =>
      dependencies.readTextFileSample(path.absolute, MAX_READ_BYTES + 1, strictOptions, signal),
    );
    if (!result.ok) nativeDenied(result);
    if (result.path !== path.absolute || result.content.includes('\uFFFD')) {
      throw new BrowserChatFileAdapterError('result_invalid');
    }
    const bytes = new TextEncoder().encode(result.content).byteLength;
    if (bytes > MAX_READ_BYTES) {
      throw new BrowserChatFileAdapterError('native_denied', 'too_large');
    }
    const secretResult = applySecretPolicy(result.content, sensitiveContentPolicy);
    if (
      secretResult.decision === 'excluded' ||
      secretResult.decision === 'ask' ||
      secretResult.text === undefined
    ) {
      throw new BrowserChatFileAdapterError('sensitive_content_blocked');
    }
    return Object.freeze({
      path: path.relative,
      content: secretResult.text,
      bytes: new TextEncoder().encode(secretResult.text).byteLength,
      redacted: secretResult.decision === 'redacted',
    });
  }

  const adapter: BrowserChatFileAdapter = {
    async list(input) {
      const path = resolveBrowserChatFilePath(input.path, root, allowSensitivePaths);
      return execute('files.list', input.lease, input.now, async (signal) => {
        const result = await callNative(() =>
          dependencies.listDirectory(path.absolute, strictOptions, signal),
        );
        if (!result.ok) nativeDenied(result);
        if (result.path !== path.absolute || !Array.isArray(result.entries)) {
          throw new BrowserChatFileAdapterError('result_invalid');
        }
        const entries = result.entries
          .map((entry) => {
            if (!entry || typeof entry.name !== 'string') return null;
            const child = resolveListedChild(
              entry.path,
              entry.name,
              path,
              root,
              allowSensitivePaths,
            );
            if (!child) return null;
            return Object.freeze({
              name: entry.name,
              path: child.relative,
              isDir: entry.isDir,
              ...(typeof entry.size === 'number' &&
              Number.isSafeInteger(entry.size) &&
              entry.size >= 0
                ? { size: entry.size }
                : {}),
            });
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        return Object.freeze({
          path: path.relative,
          entries: Object.freeze(entries.slice(0, MAX_LIST_ENTRIES)),
          truncated: entries.length > MAX_LIST_ENTRIES,
        });
      });
    },

    async read(input) {
      const path = resolveBrowserChatFilePath(input.path, root, allowSensitivePaths);
      return execute('files.read', input.lease, input.now, (signal) => readSafeText(path, signal));
    },

    async search(input) {
      const start = resolveBrowserChatFilePath(input.path, root, allowSensitivePaths);
      const query = typeof input.query === 'string' ? input.query.trim().normalize('NFKC') : '';
      if (
        query.length < 2 ||
        query.length > MAX_QUERY_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(query)
      ) {
        throw new BrowserChatFileAdapterError('query_invalid');
      }
      return execute('files.search', input.lease, input.now, async (signal) => {
        const queue: Array<BrowserChatResolvedFilePath & { depth: number }> = [
          { ...start, depth: 0 },
        ];
        const matches: Array<{ path: string; line: number; snippet: string }> = [];
        let inspectedEntries = 0;
        let searchedFiles = 0;
        let truncated = false;
        const normalizedQuery = query.toLocaleLowerCase('en-US');

        while (queue.length > 0 && !truncated) {
          if (signal.aborted) throw new BrowserChatFileAdapterError('operation_cancelled');
          const directory = queue.shift()!;
          const listed = await callNative(() =>
            dependencies.listDirectory(directory.absolute, strictOptions, signal),
          );
          if (!listed.ok) nativeDenied(listed);
          if (listed.path !== directory.absolute) {
            throw new BrowserChatFileAdapterError('result_invalid');
          }
          for (const entry of listed.entries) {
            inspectedEntries += 1;
            if (inspectedEntries > MAX_SEARCH_ENTRIES) {
              truncated = true;
              break;
            }
            if (!entry || typeof entry.name !== 'string') continue;
            const resolved = resolveListedChild(
              entry.path,
              entry.name,
              directory,
              root,
              allowSensitivePaths,
            );
            if (!resolved) continue;
            const relative = resolved.relative;
            if (entry.isDir) {
              if (directory.depth < MAX_SEARCH_DEPTH) {
                queue.push({ ...resolved, depth: directory.depth + 1 });
              } else {
                truncated = true;
              }
              continue;
            }
            searchedFiles += 1;
            if (searchedFiles > MAX_SEARCH_FILES) {
              truncated = true;
              break;
            }
            if (!TEXT_EXTENSIONS.has(extension(relative))) continue;
            const read = await callNative(() =>
              dependencies.readTextFileSample(
                resolved.absolute,
                MAX_READ_BYTES + 1,
                strictOptions,
                signal,
              ),
            );
            if (!read.ok || read.path !== resolved.absolute) continue;
            if (
              read.content.includes('\uFFFD') ||
              new TextEncoder().encode(read.content).byteLength > MAX_READ_BYTES
            ) {
              continue;
            }
            const secretResult = applySecretPolicy(read.content, sensitiveContentPolicy);
            if (secretResult.text === undefined) continue;
            const lines = secretResult.text.split(/\r?\n/u);
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index]!;
              if (!line.toLocaleLowerCase('en-US').includes(normalizedQuery)) continue;
              matches.push({
                path: relative,
                line: index + 1,
                snippet: safeSnippet(line),
              });
              if (matches.length >= MAX_SEARCH_MATCHES) {
                truncated = true;
                break;
              }
            }
            if (truncated) break;
          }
        }
        return Object.freeze({
          path: start.relative,
          query,
          matches: Object.freeze(matches.map((match) => Object.freeze(match))),
          searchedFiles,
          truncated,
        });
      });
    },
  };
  return Object.freeze(adapter);
}
