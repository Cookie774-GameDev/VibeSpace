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
    raw === 'already_exists'
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
export async function readTextFile(path: string): Promise<FsReadResult> {
  try {
    const content = await invoke<string>('fs_read_text', { path });
    return { ok: true, content, path };
  } catch (err) {
    // Tauri's invoke rejects with the raw error string from the Rust
    // command; anything else (e.g. "command not found", missing
    // bridge) is normalised under `unknown` / `unavailable`.
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function readTextFileSample(path: string, maxBytes = 64 * 1024): Promise<FsReadResult> {
  try {
    const content = await invoke<string>('fs_read_text_sample', { path, maxBytes });
    return { ok: true, content, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function listDirectory(path: string): Promise<FsListResult> {
  try {
    const entries = await invoke<FsEntry[]>('fs_list_dir', { path });
    return { ok: true, entries, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function writeTextFile(path: string, content: string): Promise<FsWriteResult> {
  try {
    await invoke('fs_write_text', { path, content });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: classifyInvokeError(err), path };
  }
}

export async function createTextFile(path: string): Promise<FsWriteResult> {
  try {
    await invoke('fs_create_text_file', { path });
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
  const settled = await Promise.allSettled(paths.map(readTextFile));
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
    case 'unavailable':
      return 'File reads only work in the desktop app.';
    case 'unknown':
    default:
      return err.raw ?? 'Could not read file.';
  }
}
