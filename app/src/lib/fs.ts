/**
 * Tiny TypeScript wrapper over the `fs_read_text` Tauri command.
 *
 * Why a wrapper:
 *   - Centralises the error-code → human-friendly mapping so the UI
 *     can surface "File too large", "Not found", etc. consistently.
 *   - Provides a `readFiles` helper that fans a list of paths through
 *     `Promise.allSettled` so a single missing file doesn't drop the
 *     whole batch (useful when an agent has 5 connected files and
 *     one path went stale).
 *   - Falls back gracefully when running outside Tauri (e.g. Vite
 *     preview without the desktop shell). Callers that need the
 *     content will see an empty result and a `notAvailable` flag.
 */

import { invoke } from '@tauri-apps/api/core';

export type FsReadErrorCode =
  | 'not_absolute'
  | 'not_found'
  | 'not_a_file'
  | 'not_a_dir'
  | 'too_large'
  | 'not_utf8'
  | 'parent_not_found'
  | 'already_exists'
  | 'unsupported_type'
  | 'outside_root'
  | 'symlink_blocked'
  | 'stale_base'
  | 'mutation_invalid'
  | 'runtime_failure'
  | 'other_user_folder'
  | 'root_not_found'
  | 'root_not_dir'
  | 'unavailable'
  | 'unknown';

export interface FsReadError {
  code: FsReadErrorCode;
  /** Raw message from the Rust side, when one exists. */
  raw?: string;
}

export type FsReadResult =
  | { ok: true; content: string; path: string }
  | { ok: false; error: FsReadError; path: string };

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  createdMs?: number;
  modifiedMs?: number;
}

export type FsListResult =
  | { ok: true; entries: FsEntry[]; path: string }
  | { ok: false; error: FsReadError; path: string };

export type FsWriteResult =
  | { ok: true; path: string }
  | { ok: false; error: FsReadError; path: string };

export type FsPathStatResult =
  | {
      ok: true;
      path: string;
      kind: 'file' | 'directory';
      size?: number;
      createdMs?: number;
      modifiedMs?: number;
      sha256?: `sha256:${string}`;
    }
  | { ok: false; error: FsReadError; path: string };

export type FsFileTransferResult =
  | {
      ok: true;
      path: string;
      sourcePath: string;
      bytes: number;
      sha256: `sha256:${string}`;
    }
  | { ok: false; error: FsReadError; path: string; sourcePath: string };

export type FsDirectoryResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; error: FsReadError; path: string };

export type FsTextMutationResult =
  | {
      ok: true;
      path: string;
      beforeSha256: `sha256:${string}` | null;
      afterSha256: `sha256:${string}` | null;
      beforeBytes: number;
      afterBytes: number;
    }
  | { ok: false; error: FsReadError; path: string };

export type FsImageReadResult =
  | { ok: true; path: string; data: string; mimeType: string; size: number }
  | { ok: false; error: FsReadError; path: string };

export interface FsAccessOptions {
  /** Selected project root. Native IPC rejects paths outside it when provided. */
  root?: string | null;
  /** Context indexing only: reject traversal, links/reparse points, and other-user roots. */
  strictProjectBoundary?: boolean;
}

export type FsHashedTextResult =
  | { ok: true; content: string; path: string; sha256: `sha256:${string}`; bytes: number }
  | { ok: false; error: FsReadError; path: string };

export async function sha256Text(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Map a Rust-side error string onto a stable code we can branch on. */
function classifyError(raw: unknown): FsReadError {
  if (typeof raw !== 'string') {
    return { code: 'unknown', raw: raw === undefined ? undefined : String(raw) };
  }
  if (
    raw === 'not_absolute' ||
    raw === 'not_found' ||
    raw === 'not_a_file' ||
    raw === 'not_a_dir' ||
    raw === 'too_large' ||
    raw === 'not_utf8' ||
    raw === 'parent_not_found' ||
    raw === 'already_exists' ||
    raw === 'unsupported_type' ||
    raw === 'outside_root' ||
    raw === 'symlink_blocked' ||
    raw === 'stale_base' ||
    raw === 'mutation_invalid' ||
    raw === 'runtime_failure' ||
    raw === 'other_user_folder' ||
    raw === 'root_not_found' ||
    raw === 'root_not_dir'
  ) {
    return { code: raw, raw };
  }
  return { code: 'unknown', raw };
}

function classifyInvokeError(err: unknown): FsReadError {
  if (typeof err === 'string') return classifyError(err);
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = String((err as { message: unknown }).message);
    if (msg.includes('not_found')) return { code: 'not_found', raw: msg };
    if (msg.includes('command') && msg.includes('not')) return { code: 'unavailable', raw: msg };
    return { code: 'unknown', raw: msg };
  }
  return { code: 'unknown' };
}

/**
 * Read one UTF-8 text file. Returns a tagged result instead of
 * throwing so callers can render a per-file error inline (the
 * connected-files popover lists paths and their fetch state).
 *
 * The Tauri runtime check is best-effort: when the `invoke` import
 * resolves but the underlying bridge isn't available (browser
 * preview, e2e harness without the shell), the call rejects and we
 * surface `unavailable` so the UI knows the feature is dark.
 */
export async function readTextFile(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsReadResult> {
  try {
    const content = await invoke<string>('fs_read_text', { path, root: options.root ?? undefined });
    return { ok: true, content, path };
  } catch (err) {
    // Tauri's invoke rejects with the raw error string from the Rust
    // command; anything else (e.g. "command not found", missing
    // bridge) is normalised under `unknown` / `unavailable`.
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function readTextFileSample(
  path: string,
  maxBytes = 64 * 1024,
  options: FsAccessOptions = {},
): Promise<FsReadResult> {
  try {
    const content = await invoke<string>('fs_read_text_sample', {
      path,
      maxBytes,
      root: options.root ?? undefined,
      strictProjectBoundary: options.strictProjectBoundary === true,
    });
    return { ok: true, content, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

/** Exact bounded read used by native evidence producers; content and hash share one snapshot. */
export async function readTextFileWithSha256(
  path: string,
  maxBytes = 256 * 1024,
  options: FsAccessOptions = {},
): Promise<FsHashedTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= 512 * 1024) {
    return { ok: false, error: { code: 'too_large' }, path };
  }
  // Read one byte beyond the accepted limit so a truncated sample can never
  // masquerade as the complete file whose digest is reported.
  const result = await readTextFileSample(path, maxBytes + 1, {
    ...options,
    strictProjectBoundary: true,
  });
  if (!result.ok) return result;
  if (result.content.includes('\uFFFD')) {
    return { ok: false, error: { code: 'not_utf8' }, path };
  }
  const bytes = new TextEncoder().encode(result.content).byteLength;
  if (bytes > maxBytes) {
    return { ok: false, error: { code: 'too_large' }, path };
  }
  return {
    ok: true,
    content: result.content,
    path: result.path,
    sha256: await sha256Text(result.content),
    bytes,
  };
}

export async function readImageFileBase64(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsImageReadResult> {
  try {
    const result = await invoke<{ data: string; mimeType: string; size: number }>(
      'fs_read_image_base64',
      { path, root: options.root ?? undefined },
    );
    return { ok: true, path, data: result.data, mimeType: result.mimeType, size: result.size };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

/** Normalize IPC payloads so snake_case / camelCase both work. */
export function normalizeFsEntry(raw: unknown): FsEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  const entryPath = typeof r.path === 'string' ? r.path : '';
  if (!name || !entryPath) return null;
  const isDir = Boolean(
    r.isDir === true || r.is_dir === true || r.isDirectory === true || r.is_directory === true,
  );
  const sizeRaw = r.size ?? r.byteSize ?? r.byte_size;
  const size = coerceFiniteNumber(sizeRaw);
  const createdRaw = r.createdMs ?? r.created_ms;
  const modifiedRaw = r.modifiedMs ?? r.modified_ms;
  return {
    name,
    path: entryPath,
    isDir,
    size,
    createdMs: coerceFiniteNumber(createdRaw),
    modifiedMs: coerceFiniteNumber(modifiedRaw),
  };
}

/** Accept number or numeric string (native u64/u128 IPC edge cases). */
function coerceFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function listDirectory(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsListResult> {
  try {
    const raw = await invoke<unknown[]>('fs_list_dir', {
      path,
      root: options.root ?? undefined,
      strictProjectBoundary: options.strictProjectBoundary === true,
    });
    const entries = (Array.isArray(raw) ? raw : [])
      .map(normalizeFsEntry)
      .filter((e): e is FsEntry => e != null);
    return { ok: true, entries, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function writeTextFile(
  path: string,
  content: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_write_text', { path, content, root: options.root ?? undefined });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function createTextFile(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_create_text_file', { path, root: options.root ?? undefined });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function createTextFileWithContent(
  path: string,
  content: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_create_text_with_content', { path, content, root: options.root ?? undefined });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function normalizeTextMutationReceipt(raw: unknown, path: string): FsTextMutationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { code: 'unknown' }, path };
  }
  const record = raw as Record<string, unknown>;
  const beforeSha256 = record.beforeSha256;
  const afterSha256 = record.afterSha256;
  const beforeBytes = record.beforeBytes;
  const afterBytes = record.afterBytes;
  if (
    (beforeSha256 !== null && (typeof beforeSha256 !== 'string' || !SHA256.test(beforeSha256))) ||
    (afterSha256 !== null && (typeof afterSha256 !== 'string' || !SHA256.test(afterSha256))) ||
    !Number.isSafeInteger(beforeBytes) ||
    (beforeBytes as number) < 0 ||
    !Number.isSafeInteger(afterBytes) ||
    (afterBytes as number) < 0 ||
    (beforeSha256 === null && beforeBytes !== 0) ||
    (afterSha256 === null && afterBytes !== 0)
  ) {
    return { ok: false, error: { code: 'unknown' }, path };
  }
  return {
    ok: true,
    path,
    beforeSha256: beforeSha256 as `sha256:${string}` | null,
    afterSha256: afterSha256 as `sha256:${string}` | null,
    beforeBytes: beforeBytes as number,
    afterBytes: afterBytes as number,
  };
}

function optionalSafeInteger(value: unknown): number | undefined | null {
  if (value === null || value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function normalizePathStat(raw: unknown, path: string): FsPathStatResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { code: 'unknown' }, path };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  const size = optionalSafeInteger(record.size);
  const createdMs = optionalSafeInteger(record.createdMs);
  const modifiedMs = optionalSafeInteger(record.modifiedMs);
  const sha256 = record.sha256;
  if (
    (kind !== 'file' && kind !== 'directory') ||
    size === null ||
    createdMs === null ||
    modifiedMs === null ||
    (sha256 !== null &&
      sha256 !== undefined &&
      (typeof sha256 !== 'string' || !SHA256.test(sha256))) ||
    (kind === 'file' && size === undefined) ||
    (kind === 'directory' && (size !== undefined || (sha256 !== null && sha256 !== undefined)))
  ) {
    return { ok: false, error: { code: 'unknown' }, path };
  }
  return {
    ok: true,
    path,
    kind,
    ...(size === undefined ? {} : { size }),
    ...(createdMs === undefined ? {} : { createdMs }),
    ...(modifiedMs === undefined ? {} : { modifiedMs }),
    ...(typeof sha256 === 'string' ? { sha256: sha256 as `sha256:${string}` } : {}),
  };
}

function normalizeFileTransfer(
  raw: unknown,
  sourcePath: string,
  path: string,
): FsFileTransferResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { code: 'unknown' }, sourcePath, path };
  }
  const record = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 0 ||
    typeof record.sha256 !== 'string' ||
    !SHA256.test(record.sha256)
  ) {
    return { ok: false, error: { code: 'unknown' }, sourcePath, path };
  }
  return {
    ok: true,
    sourcePath,
    path,
    bytes: record.bytes as number,
    sha256: record.sha256 as `sha256:${string}`,
  };
}

function normalizeDirectoryReceipt(raw: unknown, path: string): FsDirectoryResult {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof (raw as Record<string, unknown>).created !== 'boolean'
  ) {
    return { ok: false, error: { code: 'unknown' }, path };
  }
  return { ok: true, path, created: (raw as { created: boolean }).created };
}

/** Exact-base create/modify/delete for bounded UTF-8 project files. */
export async function compareAndSwapTextFile(
  path: string,
  expectedSha256: `sha256:${string}` | null,
  nextContent: string | null,
  options: FsAccessOptions = {},
): Promise<FsTextMutationResult> {
  try {
    const raw = await invoke<unknown>('fs_compare_and_swap_text', {
      path,
      expectedSha256: expectedSha256 ?? undefined,
      nextContent: nextContent ?? undefined,
      root: options.root ?? undefined,
    });
    return normalizeTextMutationReceipt(raw, path);
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function statProjectPath(
  path: string,
  includeSha256: boolean,
  options: FsAccessOptions = {},
): Promise<FsPathStatResult> {
  try {
    const raw = await invoke<unknown>('fs_stat_path', {
      path,
      includeSha256,
      root: options.root ?? undefined,
    });
    return normalizePathStat(raw, path);
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function createDirectoryWithReceipt(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsDirectoryResult> {
  try {
    const raw = await invoke<unknown>('fs_create_dir_all_strict', {
      path,
      root: options.root ?? undefined,
    });
    return normalizeDirectoryReceipt(raw, path);
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function copyProjectFile(
  sourcePath: string,
  path: string,
  options: FsAccessOptions = {},
): Promise<FsFileTransferResult> {
  try {
    const raw = await invoke<unknown>('fs_copy_file', {
      path: sourcePath,
      newPath: path,
      root: options.root ?? undefined,
    });
    return normalizeFileTransfer(raw, sourcePath, path);
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), sourcePath, path };
  }
}

export async function moveProjectFileWithReceipt(
  sourcePath: string,
  path: string,
  options: FsAccessOptions = {},
): Promise<FsFileTransferResult> {
  try {
    const raw = await invoke<unknown>('fs_move_file_with_receipt', {
      path: sourcePath,
      newPath: path,
      root: options.root ?? undefined,
    });
    return normalizeFileTransfer(raw, sourcePath, path);
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), sourcePath, path };
  }
}

export async function createDirectory(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_create_dir_all', { path, root: options.root ?? undefined });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function renameProjectFile(
  path: string,
  newPath: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_rename_file', { path, newPath, root: options.root ?? undefined });
    return { ok: true, path: newPath };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function deleteProjectFile(
  path: string,
  options: FsAccessOptions = {},
): Promise<FsWriteResult> {
  try {
    await invoke('fs_delete_file', { path, root: options.root ?? undefined });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

/**
 * Read multiple files in parallel. Failures are folded into the
 * returned list rather than rejecting the whole batch — the AI
 * runtime treats missing files as "skip this one and add a note to
 * the prompt" rather than a hard failure.
 */
export async function readTextFiles(paths: string[]): Promise<FsReadResult[]> {
  if (paths.length === 0) return [];
  const settled = await Promise.allSettled(paths.map((path) => readTextFile(path)));
  return settled.map((r, i) => {
    const path = paths[i] ?? '';
    if (r.status === 'fulfilled') return r.value;
    return {
      ok: false,
      error: { code: 'unknown', raw: String(r.reason) },
      path,
    };
  });
}

/** Human label for an error code; used by the connected-files UI. */
export function describeFsError(err: FsReadError): string {
  switch (err.code) {
    case 'not_absolute':
      return 'Use an absolute path.';
    case 'not_found':
      return 'File not found.';
    case 'not_a_file':
      return 'Path is not a regular file.';
    case 'not_a_dir':
      return 'Path is not a folder.';
    case 'too_large':
      return 'File exceeds the 100 MB read cap.';
    case 'not_utf8':
      return 'File is not valid UTF-8 text.';
    case 'parent_not_found':
      return 'Parent folder does not exist.';
    case 'already_exists':
      return 'A file already exists at that path.';
    case 'unsupported_type':
      return 'Unsupported image type.';
    case 'outside_root':
      return 'Path is outside the selected project folder.';
    case 'symlink_blocked':
      return 'Project indexing does not follow symbolic links or junctions.';
    case 'other_user_folder':
      return 'Project indexing cannot scan another user profile.';
    case 'root_not_found':
      return 'Project folder not found.';
    case 'root_not_dir':
      return 'Project root is not a folder.';
    case 'unavailable':
      return 'File reads only work in the desktop app.';
    case 'unknown':
    default:
      return err.raw ?? 'Could not read file.';
  }
}
