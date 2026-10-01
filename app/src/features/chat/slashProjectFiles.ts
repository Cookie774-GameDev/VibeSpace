/**
 * Project file listing for the /file slash picker.
 * Bounded walk of the active project root — safe for the composer UI.
 */
import { listDirectory, type FsEntry } from '@/lib/fs';
import { basename, getStoredOpenFile, getStoredProjectRoot } from '@/features/files/projectFiles';
import type { SlashCommandOption } from './SlashCommandOptionPicker';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  'vendor',
  '__pycache__',
  '.cache',
  'coverage',
  '.venv',
  'venv',
]);

const MAX_ATTACHMENT_PATH_LENGTH = 4_096;

export function isSafeAbsoluteAttachmentPath(path: string): boolean {
  if (!path || path !== path.trim() || path.length > MAX_ATTACHMENT_PATH_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
    return false;
  }
  const isWindowsDrive = /^[A-Za-z]:[\\/]/u.test(path);
  const isUnc = /^\\\\[^\\/]+\\[^\\/]+/u.test(path);
  const isPosix = path.startsWith('/') && !path.startsWith('//');
  if (!isWindowsDrive && !isUnc && !isPosix) return false;
  return !path.split(/[\\/]+/u).some((segment) => segment === '..');
}

export interface ListProjectFileOptionsParams {
  projectId: string | null;
  maxFiles?: number;
  maxDepth?: number;
}

/**
 * List files under the project root for /file attachment.
 * Open file (if any) is sorted first.
 */
export async function listProjectFileOptions(
  params: ListProjectFileOptionsParams,
): Promise<{ options: SlashCommandOption[]; root: string; error?: string }> {
  const root = getStoredProjectRoot(params.projectId).trim();
  if (!root) {
    return {
      options: [],
      root: '',
      error: 'No project folder open. Open a project in Files first, then use /file.',
    };
  }

  const maxFiles = params.maxFiles ?? 250;
  const maxDepth = params.maxDepth ?? 5;
  const openFile = getStoredOpenFile(params.projectId).trim();
  const files: FsEntry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0 && files.length < maxFiles) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) continue;
    const key = item.path.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const listed = await listDirectory(item.path, { root });
    if (!listed.ok) continue;
    for (const entry of listed.entries) {
      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.vscode') {
          if (item.depth > 0) continue;
        }
        if (item.depth < maxDepth) {
          queue.push({ path: entry.path, depth: item.depth + 1 });
        }
        continue;
      }
      files.push(entry);
      if (files.length >= maxFiles) break;
    }
  }

  files.sort((a, b) => {
    if (openFile) {
      const aOpen = a.path === openFile ? 0 : 1;
      const bOpen = b.path === openFile ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const options: SlashCommandOption[] = files.map((file) => {
    const rel = relativeDisplayPath(root, file.path);
    return {
      id: file.path,
      label: file.name,
      description: rel !== file.name ? rel : undefined,
      metadata:
        file.path === openFile ? 'open' : file.size != null ? formatBytes(file.size) : undefined,
    };
  });

  return { options, root };
}

export function relativeDisplayPath(root: string, path: string): string {
  const normRoot = root.replace(/[\\/]+$/, '');
  const normPath = path;
  if (normPath.toLowerCase().startsWith(normRoot.toLowerCase())) {
    const rest = normPath.slice(normRoot.length).replace(/^[\\/]+/, '');
    return rest || basename(path);
  }
  return path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Detect an inline slash token at caret (works at start, middle after space/punct, or end).
 * Query is the command fragment without the leading '/'.
 */
export function getInlineSlashContext(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '/') {
      const prev = i === 0 ? '' : value[i - 1]!;
      // Allow after start, whitespace, or common punctuation so mid-message works.
      if (i === 0 || /[\s([{'"`,;:]/.test(prev)) {
        const query = value.slice(i + 1, caret);
        if (!/\s/.test(query)) {
          return { start: i, query };
        }
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i -= 1;
  }
  return null;
}

/**
 * Pull standalone slash utility tokens from free text (for send-time handling).
 * Does not strip /multitask tasks with long args mid-sentence aggressively —
 * only known attach/utility commands.
 */
const INLINE_CLEAR_RE = /(^|[\s([{'"`,;:])\/(clearfiles?|clear-files|cearfiles?)\b/gi;
// Path token allows dots (readme.md). Trailing sentence punct is trimmed later.
const INLINE_FILE_RE = /(^|[\s([{'"`,;:])\/(file|attach)(?:[ \t]+("([^"]+)"|'([^']+)'|(\S+)))?/gi;
const INLINE_HELP_RE = /(^|[\s([{'"`,;:])\/(usage|help|commands)\b/gi;

function normalizeUtilityCmd(cmd: string): string {
  const c = cmd.toLowerCase();
  if (c === 'clearfile' || c === 'clear-files' || c === 'cearfile' || c === 'cearfiles') {
    return 'clearfiles';
  }
  return c;
}

export function extractInlineUtilitySlashCommands(text: string): {
  cleaned: string;
  utilities: Array<{ cmd: string; rest: string; raw: string }>;
} {
  const utilities: Array<{ cmd: string; rest: string; raw: string }> = [];
  let cleaned = text;

  const collect = (re: RegExp, restFromMatch: (m: RegExpExecArray) => string) => {
    re.lastIndex = 0;
    const matches = [...cleaned.matchAll(re)].reverse();
    for (const m of matches) {
      const cmd = normalizeUtilityCmd(m[2] ?? '');
      const prefix = m[1] ?? '';
      const full = m[0] ?? '';
      const raw = full.slice(prefix.length).trim();
      const rest = restFromMatch(m).trim();
      utilities.unshift({ cmd, rest, raw });
      cleaned = cleaned.slice(0, m.index) + prefix + cleaned.slice((m.index ?? 0) + full.length);
    }
  };

  // Order: file/attach (with path token), then clear, then help/usage/commands
  collect(INLINE_FILE_RE, (m) => {
    const raw = (m[4] || m[5] || m[6] || '').trim();
    // Keep extension dots; only strip trailing sentence punctuation.
    return raw.replace(/[),;:!?]+$/g, '');
  });
  collect(INLINE_CLEAR_RE, () => '');
  collect(INLINE_HELP_RE, () => '');

  cleaned = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleaned, utilities };
}
