import { db, openDb } from '@/lib/db';
import {
  compareAndSwapTextFile,
  createDirectoryWithReceipt,
  listDirectory,
  readTextFileSample,
  sha256Text,
  type FsDirectoryResult,
  type FsListResult,
  type FsReadResult,
  type FsTextMutationResult,
} from '@/lib/fs';
import { isTauri } from '@/lib/utils';
import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import {
  createMarkdownLibraryAuthority,
  MARKDOWN_LIBRARY_MUTATION_MAX_BYTES,
  type MarkdownLibraryFilePort,
  type MarkdownLibraryRepository,
  type MarkdownLibrarySnapshot,
} from './runtime';
import type { MarkdownLibraryScope } from './contracts';

type NativeFiles = Readonly<{
  createDirectory: (path: string, options: { root: string }) => Promise<FsDirectoryResult>;
  list: (
    path: string,
    options: { root: string; strictProjectBoundary: true },
  ) => Promise<FsListResult>;
  read: (path: string, options: { root: string }) => Promise<FsReadResult>;
  compareAndSwap: (
    path: string,
    expectedSha256: `sha256:${string}` | null,
    content: string,
    options: { root: string },
  ) => Promise<FsTextMutationResult>;
}>;

export interface MarkdownLibraryIndexStore {
  read(key: string): Promise<MarkdownLibrarySnapshot | undefined>;
  compareAndSet(
    key: string,
    expectedGeneration: number,
    next: MarkdownLibrarySnapshot,
  ): Promise<boolean>;
}

const nativeFiles: NativeFiles = {
  createDirectory: createDirectoryWithReceipt,
  list: listDirectory,
  read: (path, options) =>
    readTextFileSample(path, MARKDOWN_LIBRARY_MUTATION_MAX_BYTES + 1, {
      ...options,
      strictProjectBoundary: true,
    }),
  compareAndSwap: compareAndSwapTextFile,
};

function emptySnapshot(): MarkdownLibrarySnapshot {
  return { generation: 0, documents: [], revisions: [], pendingRollback: null };
}

export function createDexieMarkdownIndexStore(): MarkdownLibraryIndexStore {
  return {
    async read(key) {
      await openDb();
      return db.settings.get(key).then((row) => row?.value as MarkdownLibrarySnapshot | undefined);
    },
    async compareAndSet(key, expectedGeneration, next) {
      await openDb();
      return db.transaction('rw', db.settings, async () => {
        const row = await db.settings.get(key);
        const current = row?.value as MarkdownLibrarySnapshot | undefined;
        if ((current?.generation ?? 0) !== expectedGeneration) return false;
        await db.settings.put({ key, value: next, updated_at: Date.now() });
        return true;
      });
    },
  };
}

function safeResult<T extends { ok: boolean; error?: { code: string } }>(
  result: T,
  operation: string,
): T {
  if (!result.ok)
    throw new Error(`markdown_library_${operation}_${result.error?.code ?? 'unknown'}`);
  return result;
}

function join(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/u, '')}${separator}${child}`;
}

/**
 * Open one app-owned native Markdown library. The physical files live under
 * app data, never in an arbitrary project root, and the index is scoped to
 * the same account/project/root tuple in the local durable database.
 */
export async function openNativeMarkdownLibrary(
  accountId: string,
  projectId: string,
  options: Readonly<{
    dataRoot?: string;
    files?: NativeFiles;
    indexStore?: MarkdownLibraryIndexStore;
  }> = {},
) {
  if (!isTauri && !options.dataRoot) throw new Error('markdown_library_native_required');
  const dataRoot = normalizePortableAbsolutePath(
    options.dataRoot ?? (await (await import('@tauri-apps/api/path')).appDataDir()),
  );
  if (!dataRoot) throw new Error('markdown_library_root_invalid');
  const accountHash = (await sha256Text(accountId)).slice('sha256:'.length);
  const projectHash = (await sha256Text(projectId)).slice('sha256:'.length);
  const base = join(dataRoot, 'MarkdownLibrary');
  const accountFolder = join(base, accountHash.slice(0, 32));
  const root = join(accountFolder, projectHash.slice(0, 32));
  const files = options.files ?? nativeFiles;
  for (const folder of [base, accountFolder, root]) {
    safeResult(await files.createDirectory(folder, { root: dataRoot }), 'directory');
  }
  const scope: MarkdownLibraryScope = { accountId, projectId, root };
  const key = `markdown-library-v1:${accountHash}:${projectHash}:${(await sha256Text(root)).slice('sha256:'.length)}`;
  const indexStore = options.indexStore ?? createDexieMarkdownIndexStore();

  const filePort: MarkdownLibraryFilePort = {
    async scanMarkdown(currentScope) {
      const listed = safeResult(
        await files.list(currentScope.root, {
          root: currentScope.root,
          strictProjectBoundary: true,
        }),
        'list',
      );
      if (!listed.ok) throw new Error('markdown_library_list_unavailable');
      const entries = listed.entries.filter(
        (entry) => !entry.isDir && entry.name.toLocaleLowerCase('en-US').endsWith('.md'),
      );
      return Promise.all(
        entries.map(async (entry) => {
          const result = safeResult(
            await files.read(entry.path, { root: currentScope.root }),
            'read',
          );
          if (!result.ok) throw new Error('markdown_library_read_unavailable');
          if (
            new TextEncoder().encode(result.content).byteLength >
            MARKDOWN_LIBRARY_MUTATION_MAX_BYTES
          ) {
            throw new Error('markdown_library_content_invalid');
          }
          return { path: entry.path, content: result.content, modifiedAt: entry.modifiedMs ?? 0 };
        }),
      );
    },
    async readText({ path, root: currentRoot }) {
      const result = await files.read(path, { root: currentRoot });
      if (!result.ok && result.error.code === 'not_found') return null;
      safeResult(result, 'read');
      if (
        result.ok &&
        new TextEncoder().encode(result.content).byteLength > MARKDOWN_LIBRARY_MUTATION_MAX_BYTES
      ) {
        throw new Error('markdown_library_content_invalid');
      }
      return result.ok ? result.content : null;
    },
    async compareAndWrite({ path, root: currentRoot, expectedSha256, content }) {
      const result = await files.compareAndSwap(path, expectedSha256, content, {
        root: currentRoot,
      });
      if (!result.ok && ['stale_base', 'already_exists', 'not_found'].includes(result.error.code)) {
        return false;
      }
      safeResult(result, 'write');
      return true;
    },
  };
  const repository: MarkdownLibraryRepository = {
    readProjectIndex() {
      return indexStore.read(key).then((snapshot) => snapshot ?? emptySnapshot());
    },
    replaceProjectIndex({ expectedGeneration, next }) {
      return indexStore.compareAndSet(key, expectedGeneration, next);
    },
  };
  return { scope, authority: createMarkdownLibraryAuthority({ filePort, repository }) };
}
