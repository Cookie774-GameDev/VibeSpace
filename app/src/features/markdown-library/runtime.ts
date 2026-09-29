import { isPathInsideRoot, normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import { sha256Text } from '@/lib/fs';
import {
  MARKDOWN_LIBRARY_MAX_BYTES,
  parseMarkdownDocumentMetadata,
  parseMarkdownHistoryCursor,
  parseMarkdownRollbackPreparation,
  parseMarkdownRevision,
  type MarkdownDocumentMetadataV1,
  type MarkdownHistoryCursorV1,
  type MarkdownLibraryDocumentKind,
  type MarkdownLibraryScope,
  type MarkdownRollbackPreparationV1,
  type MarkdownRevisionV1,
} from './contracts';

/** The native exact-base text mutation command accepts at most 256 KiB. */
export const MARKDOWN_LIBRARY_MUTATION_MAX_BYTES = 256 * 1024;

export type MarkdownPhysicalFile = Readonly<{
  path: string;
  content: string;
  modifiedAt: number;
}>;

export type MarkdownLibrarySnapshot = Readonly<{
  generation: number;
  documents: readonly MarkdownDocumentMetadataV1[];
  revisions: readonly MarkdownRevisionV1[];
  pendingRollback: MarkdownRollbackPreparationV1 | null;
}>;

export interface MarkdownLibraryFilePort {
  scanMarkdown(scope: MarkdownLibraryScope): Promise<readonly MarkdownPhysicalFile[]>;
  readText(input: { path: string; root: string }): Promise<string | null>;
  compareAndWrite(input: {
    path: string;
    root: string;
    expectedSha256: `sha256:${string}` | null;
    content: string;
  }): Promise<boolean>;
}

export interface MarkdownLibraryRepository {
  readProjectIndex(scope: MarkdownLibraryScope): Promise<MarkdownLibrarySnapshot>;
  replaceProjectIndex(input: {
    scope: MarkdownLibraryScope;
    expectedGeneration: number;
    next: MarkdownLibrarySnapshot;
  }): Promise<boolean>;
}

export type MarkdownHistoryProjection = Readonly<{
  revision: number;
  contentSha256: `sha256:${string}`;
  sizeBytes: number;
  createdAt: number;
}>;

export type MarkdownHistoryPage = Readonly<{
  items: readonly MarkdownHistoryProjection[];
  nextCursor: MarkdownHistoryCursorV1 | null;
}>;

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KINDS: readonly Exclude<MarkdownLibraryDocumentKind, 'custom'>[] = [
  'goal',
  'agent',
  'skill',
  'prompt',
  'design',
  'test',
  'policy',
  'context',
];
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;

function normalizeScope(input: MarkdownLibraryScope): MarkdownLibraryScope {
  const root = normalizePortableAbsolutePath(input.root);
  if (!SCOPE_ID.test(input.accountId) || !SCOPE_ID.test(input.projectId) || !root) {
    throw new Error('markdown_library_scope_invalid');
  }
  return Object.freeze({ accountId: input.accountId, projectId: input.projectId, root });
}

function pathKey(path: string, root: string): string {
  return /^[A-Za-z]:\\|^\\\\/u.test(root) ? path.toLocaleLowerCase('en-US') : path;
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function writableContent(content: string): string {
  if (typeof content !== 'string' || byteLength(content) > MARKDOWN_LIBRARY_MUTATION_MAX_BYTES) {
    throw new Error('markdown_library_content_invalid');
  }
  return content;
}

async function newDocumentPath(scope: MarkdownLibraryScope, title: string): Promise<string> {
  const clean = title.trim();
  if (clean.length < 1 || clean.length > 256 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error('markdown_library_title_invalid');
  }
  const slug =
    clean
      .normalize('NFKD')
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, 48) || 'document';
  const digest = (await sha256Text(clean)).slice('sha256:'.length, 'sha256:'.length + 12);
  const separator = scope.root.includes('\\') ? '\\' : '/';
  return `${scope.root}${separator}${slug}-${digest}.md`;
}

function inferKind(path: string): MarkdownLibraryDocumentKind {
  const filename =
    path.split(/[\\/]/u).at(-1)?.replace(/\.md$/iu, '').toLocaleLowerCase('en-US') ?? '';
  return (
    KINDS.find(
      (kind) =>
        filename === kind || filename.startsWith(`${kind}-`) || filename.startsWith(`${kind}_`),
    ) ?? 'custom'
  );
}

function inferTitle(path: string, content: string): string {
  const heading = /^#\s+([^\r\n]+)$/mu.exec(content)?.[1]?.trim();
  const fallback =
    path.split(/[\\/]/u).at(-1)?.replace(/\.md$/iu, '').replace(/[-_]+/gu, ' ').trim() ||
    'Untitled Markdown';
  const title = (heading || fallback).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  if (!title) throw new Error('markdown_library_inventory_invalid');
  return title.slice(0, 256);
}

async function documentId(path: string, root: string): Promise<`mdoc_${string}`> {
  const digest = await sha256Text(pathKey(path, root));
  return `mdoc_${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

async function validSnapshot(
  input: MarkdownLibrarySnapshot,
  scope: MarkdownLibraryScope,
): Promise<MarkdownLibrarySnapshot> {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('markdown_library_index_invalid');
  }
  const documents = input.documents.map(parseMarkdownDocumentMetadata);
  const revisions = input.revisions.map(parseMarkdownRevision);
  if (documents.some((value) => value === null) || revisions.some((value) => value === null)) {
    throw new Error('markdown_library_index_invalid');
  }
  const safeDocuments = documents as MarkdownDocumentMetadataV1[];
  const safeRevisions = revisions as MarkdownRevisionV1[];
  const pendingRollback =
    input.pendingRollback === null || input.pendingRollback === undefined
      ? null
      : parseMarkdownRollbackPreparation(input.pendingRollback);
  if (input.pendingRollback !== null && input.pendingRollback !== undefined && !pendingRollback) {
    throw new Error('markdown_library_index_invalid');
  }
  const documentIds = new Set<string>();
  const paths = new Set<string>();
  for (const document of safeDocuments) {
    const key = pathKey(document.path, scope.root);
    if (
      document.accountId !== scope.accountId ||
      document.projectId !== scope.projectId ||
      pathKey(document.root, scope.root) !== pathKey(scope.root, scope.root) ||
      documentIds.has(document.documentId) ||
      paths.has(key)
    ) {
      throw new Error('markdown_library_index_invalid');
    }
    documentIds.add(document.documentId);
    paths.add(key);
  }
  const revisionKeys = new Set<string>();
  const highestRevisionByDocument = new Map<string, number>();
  for (const revision of safeRevisions) {
    const key = `${revision.documentId}:${revision.revision}`;
    if (revisionKeys.has(key) || (await sha256Text(revision.content)) !== revision.contentSha256) {
      throw new Error('markdown_library_index_invalid');
    }
    revisionKeys.add(key);
    highestRevisionByDocument.set(
      revision.documentId,
      Math.max(highestRevisionByDocument.get(revision.documentId) ?? 0, revision.revision),
    );
  }
  for (const document of safeDocuments) {
    if (
      highestRevisionByDocument.get(document.documentId) !== document.revision ||
      !safeRevisions.some(
        (revision) =>
          revision.documentId === document.documentId &&
          revision.revision === document.revision &&
          revision.contentSha256 === document.contentSha256,
      )
    ) {
      throw new Error('markdown_library_index_invalid');
    }
  }
  if (pendingRollback) {
    const document = safeDocuments.find(
      (candidate) => candidate.documentId === pendingRollback.documentId,
    );
    const target = safeRevisions.find(
      (revision) =>
        revision.documentId === pendingRollback.documentId &&
        revision.revision === pendingRollback.targetRevision,
    );
    if (
      !document ||
      !target ||
      document.revision !== pendingRollback.fromRevision ||
      document.contentSha256 === target.contentSha256
    ) {
      throw new Error('markdown_library_index_invalid');
    }
  }
  return Object.freeze({
    generation: input.generation,
    documents: Object.freeze(safeDocuments),
    revisions: Object.freeze(safeRevisions),
    pendingRollback,
  });
}

function publicHistory(revision: MarkdownRevisionV1): MarkdownHistoryProjection {
  return Object.freeze({
    revision: revision.revision,
    contentSha256: revision.contentSha256,
    sizeBytes: revision.sizeBytes,
    createdAt: revision.createdAt,
  });
}

const liveScopeOperations = new Map<string, Promise<void>>();
const invokingScopeDependencies = new Set<string>();

function scopeOperationKey(scope: MarkdownLibraryScope): string {
  return JSON.stringify([scope.accountId, scope.projectId, pathKey(scope.root, scope.root)]);
}

function invokeScopeDependency<T>(
  scope: MarkdownLibraryScope,
  operation: () => Promise<T>,
): Promise<T> {
  const key = scopeOperationKey(scope);
  invokingScopeDependencies.add(key);
  try {
    return Promise.resolve(operation());
  } finally {
    invokingScopeDependencies.delete(key);
  }
}

async function serializeScopeOperation<T>(
  scope: MarkdownLibraryScope,
  operation: () => Promise<T>,
): Promise<T> {
  const key = scopeOperationKey(scope);
  if (invokingScopeDependencies.has(key)) {
    throw new Error('markdown_library_scope_reentrant');
  }
  const prior = liveScopeOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ownership = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => ownership);
  liveScopeOperations.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (liveScopeOperations.get(key) === tail) liveScopeOperations.delete(key);
  }
}

export function createMarkdownLibraryAuthority(input: {
  filePort: MarkdownLibraryFilePort;
  repository: MarkdownLibraryRepository;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;

  async function readSnapshot(scope: MarkdownLibraryScope) {
    return validSnapshot(
      await invokeScopeDependency(scope, () => input.repository.readProjectIndex(scope)),
      scope,
    );
  }

  function samePreparation(
    left: MarkdownRollbackPreparationV1 | null,
    right: MarkdownRollbackPreparationV1,
  ): boolean {
    return (
      left !== null &&
      left.documentId === right.documentId &&
      left.fromRevision === right.fromRevision &&
      left.targetRevision === right.targetRevision &&
      left.createdAt === right.createdAt
    );
  }

  async function recoverPendingRollback(
    scope: MarkdownLibraryScope,
    initial: MarkdownLibrarySnapshot,
  ): Promise<MarkdownLibrarySnapshot> {
    let snapshot = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = snapshot.pendingRollback;
      if (!pending) return snapshot;
      const document = snapshot.documents.find(
        (candidate) => candidate.documentId === pending.documentId,
      )!;
      const currentRevision = snapshot.revisions.find(
        (revision) =>
          revision.documentId === pending.documentId && revision.revision === pending.fromRevision,
      )!;
      const target = snapshot.revisions.find(
        (revision) =>
          revision.documentId === pending.documentId &&
          revision.revision === pending.targetRevision,
      )!;
      const physical = await invokeScopeDependency(scope, () =>
        input.filePort.readText({ path: document.path, root: scope.root }),
      );
      if (physical === null) throw new Error('markdown_library_rollback_recovery_failed');
      const physicalSha256 = await sha256Text(physical);
      if (physicalSha256 === target.contentSha256) {
        let compensated = false;
        try {
          compensated = await invokeScopeDependency(scope, () =>
            input.filePort.compareAndWrite({
              path: document.path,
              root: scope.root,
              expectedSha256: target.contentSha256,
              content: currentRevision.content,
            }),
          );
        } catch {
          compensated = false;
        }
        if (!compensated) {
          const observed = await invokeScopeDependency(scope, () =>
            input.filePort.readText({
              path: document.path,
              root: scope.root,
            }),
          );
          if (observed === null || (await sha256Text(observed)) !== document.contentSha256) {
            throw new Error('markdown_library_rollback_compensation_failed');
          }
        }
      } else if (physicalSha256 !== document.contentSha256) {
        throw new Error('markdown_library_rollback_compensation_failed');
      }

      const cleared = await validSnapshot(
        Object.freeze({
          generation: snapshot.generation + 1,
          documents: snapshot.documents,
          revisions: snapshot.revisions,
          pendingRollback: null,
        }),
        scope,
      );
      let replaced = false;
      try {
        replaced = await invokeScopeDependency(scope, () =>
          input.repository.replaceProjectIndex({
            scope,
            expectedGeneration: snapshot.generation,
            next: cleared,
          }),
        );
      } catch {
        replaced = false;
      }
      if (replaced) return cleared;
      const observed = await readSnapshot(scope);
      if (!observed.pendingRollback) {
        const observedDocument = observed.documents.find(
          (candidate) => candidate.documentId === pending.documentId,
        );
        const observedContent = observedDocument
          ? await invokeScopeDependency(scope, () =>
              input.filePort.readText({ path: observedDocument.path, root: scope.root }),
            )
          : null;
        if (
          observedDocument &&
          observedContent !== null &&
          (await sha256Text(observedContent)) === observedDocument.contentSha256
        ) {
          return observed;
        }
        throw new Error('markdown_library_rollback_recovery_failed');
      }
      if (!samePreparation(observed.pendingRollback, pending)) {
        throw new Error('markdown_library_rollback_recovery_failed');
      }
      snapshot = observed;
    }
    throw new Error('markdown_library_rollback_recovery_failed');
  }

  async function read(scopeInput: MarkdownLibraryScope) {
    const scope = normalizeScope(scopeInput);
    let snapshot = await readSnapshot(scope);
    if (snapshot.pendingRollback) snapshot = await recoverPendingRollback(scope, snapshot);
    return { scope, snapshot };
  }

  const authority = Object.freeze({
    async reindex(
      scopeInput: MarkdownLibraryScope,
    ): Promise<readonly MarkdownDocumentMetadataV1[]> {
      const { scope, snapshot } = await read(scopeInput);
      const inventory = await invokeScopeDependency(scope, () =>
        input.filePort.scanMarkdown(scope),
      );
      const seen = new Set<string>();
      const nextDocuments: MarkdownDocumentMetadataV1[] = [];
      const nextRevisions = [...snapshot.revisions];
      const indexedAt = now();
      if (!Number.isSafeInteger(indexedAt) || indexedAt < 0) {
        throw new Error('markdown_library_clock_invalid');
      }
      for (const candidate of inventory) {
        const path = normalizePortableAbsolutePath(candidate.path);
        const sizeBytes = byteLength(candidate.content);
        if (
          !path ||
          !isPathInsideRoot(path, scope.root) ||
          !path.toLocaleLowerCase('en-US').endsWith('.md') ||
          seen.has(pathKey(path, scope.root)) ||
          sizeBytes > MARKDOWN_LIBRARY_MAX_BYTES
        ) {
          throw new Error('markdown_library_inventory_invalid');
        }
        seen.add(pathKey(path, scope.root));
        const id = await documentId(path, scope.root);
        const sha256 = await sha256Text(candidate.content);
        const prior = snapshot.documents.find(
          (document) => pathKey(document.path, scope.root) === pathKey(path, scope.root),
        );
        if (prior && prior.documentId !== id) throw new Error('markdown_library_index_invalid');
        const retainedRevision = snapshot.revisions
          .filter((candidate) => candidate.documentId === id)
          .sort((left, right) => left.revision - right.revision)
          .at(-1);
        const priorRevision = prior?.revision ?? retainedRevision?.revision;
        const priorSha256 = prior?.contentSha256 ?? retainedRevision?.contentSha256;
        const changed = priorSha256 !== sha256;
        const revision = priorRevision ? (changed ? priorRevision + 1 : priorRevision) : 1;
        const document = parseMarkdownDocumentMetadata({
          schemaVersion: 1,
          documentId: id,
          accountId: scope.accountId,
          projectId: scope.projectId,
          root: scope.root,
          path,
          kind: inferKind(path),
          title: inferTitle(path, candidate.content),
          contentSha256: sha256,
          sizeBytes,
          revision,
          indexedAt,
        });
        if (!document) throw new Error('markdown_library_inventory_invalid');
        nextDocuments.push(document);
        if (!priorRevision || changed) {
          const history = parseMarkdownRevision({
            schemaVersion: 1,
            documentId: id,
            revision,
            contentSha256: sha256,
            sizeBytes,
            createdAt: indexedAt,
            content: candidate.content,
          });
          if (!history) throw new Error('markdown_library_inventory_invalid');
          nextRevisions.push(history);
        }
      }
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
      const next = await validSnapshot(
        Object.freeze({
          generation: snapshot.generation + 1,
          documents: Object.freeze(nextDocuments),
          revisions: Object.freeze(nextRevisions),
          pendingRollback: null,
        }),
        scope,
      );
      if (
        !(await invokeScopeDependency(scope, () =>
          input.repository.replaceProjectIndex({
            scope,
            expectedGeneration: snapshot.generation,
            next,
          }),
        ))
      ) {
        throw new Error('markdown_library_index_conflict');
      }
      return next.documents;
    },

    async list(
      scopeInput: MarkdownLibraryScope,
      filter: Readonly<{
        query?: string;
        kind?: MarkdownLibraryDocumentKind;
        limit?: number;
      }> = {},
    ): Promise<readonly MarkdownDocumentMetadataV1[]> {
      const { snapshot } = await read(scopeInput);
      const query = filter.query?.trim().toLocaleLowerCase('en-US') ?? '';
      const limit = Number.isInteger(filter.limit)
        ? Math.min(MAX_LIST_LIMIT, Math.max(1, filter.limit!))
        : DEFAULT_LIST_LIMIT;
      return Object.freeze(
        snapshot.documents
          .filter(
            (document) =>
              (!filter.kind || document.kind === filter.kind) &&
              (!query ||
                [
                  document.title,
                  document.path,
                  document.kind,
                  snapshot.revisions.find(
                    (revision) =>
                      revision.documentId === document.documentId &&
                      revision.revision === document.revision,
                  )?.content ?? '',
                ].some((value) => value.toLocaleLowerCase('en-US').includes(query))),
          )
          .slice(0, limit),
      );
    },

    async create(
      scopeInput: MarkdownLibraryScope,
      draft: Readonly<{ title: string; body: string }>,
    ): Promise<MarkdownDocumentMetadataV1> {
      const { scope, snapshot } = await read(scopeInput);
      const path = await newDocumentPath(scope, draft.title);
      const content = writableContent(`# ${draft.title.trim()}\n\n${draft.body}`);
      if (
        snapshot.documents.some(
          (document) => pathKey(document.path, scope.root) === pathKey(path, scope.root),
        )
      ) {
        throw new Error('markdown_library_file_exists');
      }
      const created = await invokeScopeDependency(scope, () =>
        input.filePort.compareAndWrite({ path, root: scope.root, expectedSha256: null, content }),
      );
      if (!created) throw new Error('markdown_library_file_exists');
      const indexed = await authority.reindex(scope);
      const document = indexed.find(
        (candidate) => pathKey(candidate.path, scope.root) === pathKey(path, scope.root),
      );
      if (!document) throw new Error('markdown_library_index_conflict');
      return document;
    },

    async open(scopeInput: MarkdownLibraryScope, id: string) {
      const { scope, snapshot } = await read(scopeInput);
      const document = snapshot.documents.find((candidate) => candidate.documentId === id);
      if (!document) throw new Error('markdown_library_revision_unavailable');
      const content = await invokeScopeDependency(scope, () =>
        input.filePort.readText({ path: document.path, root: scope.root }),
      );
      if (content === null || (await sha256Text(content)) !== document.contentSha256) {
        throw new Error('markdown_library_file_stale');
      }
      return Object.freeze({ document, content });
    },

    async save(
      scopeInput: MarkdownLibraryScope,
      id: string,
      expectedRevision: number,
      contentInput: string,
    ): Promise<MarkdownDocumentMetadataV1> {
      const { scope, snapshot } = await read(scopeInput);
      const document = snapshot.documents.find((candidate) => candidate.documentId === id);
      if (!document || document.revision !== expectedRevision) {
        throw new Error('markdown_library_revision_stale');
      }
      const content = writableContent(contentInput);
      if ((await sha256Text(content)) === document.contentSha256) return document;
      const written = await invokeScopeDependency(scope, () =>
        input.filePort.compareAndWrite({
          path: document.path,
          root: scope.root,
          expectedSha256: document.contentSha256,
          content,
        }),
      );
      if (!written) throw new Error('markdown_library_file_stale');
      const indexed = await authority.reindex(scope);
      const saved = indexed.find((candidate) => candidate.documentId === id);
      if (!saved || saved.contentSha256 !== (await sha256Text(content))) {
        throw new Error('markdown_library_index_conflict');
      }
      return saved;
    },

    async revisionContent(scopeInput: MarkdownLibraryScope, id: string, revision: number) {
      const { snapshot } = await read(scopeInput);
      if (!snapshot.documents.some((document) => document.documentId === id)) {
        throw new Error('markdown_library_revision_unavailable');
      }
      const target = snapshot.revisions.find(
        (entry) => entry.documentId === id && entry.revision === revision,
      );
      if (!target) throw new Error('markdown_library_revision_unavailable');
      return target.content;
    },

    async history(
      scopeInput: MarkdownLibraryScope,
      id: string,
      options: Readonly<{ limit?: number; cursor?: MarkdownHistoryCursorV1 }> = {},
    ): Promise<MarkdownHistoryPage> {
      const { snapshot } = await read(scopeInput);
      const cursor = options.cursor ? parseMarkdownHistoryCursor(options.cursor) : null;
      if (options.cursor && (!cursor || cursor.documentId !== id)) {
        throw new Error('markdown_library_history_cursor_invalid');
      }
      const limit = Number.isInteger(options.limit)
        ? Math.min(MAX_HISTORY_LIMIT, Math.max(1, options.limit!))
        : DEFAULT_HISTORY_LIMIT;
      if (!snapshot.documents.some((document) => document.documentId === id)) {
        return Object.freeze({ items: Object.freeze([]), nextCursor: null });
      }
      const candidates = snapshot.revisions
        .filter(
          (revision) =>
            revision.documentId === id &&
            (cursor === null || revision.revision < cursor.beforeRevision),
        )
        .sort((left, right) => right.revision - left.revision);
      const page = candidates.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        last && candidates.length > page.length
          ? Object.freeze({
              schemaVersion: 1 as const,
              documentId: last.documentId,
              beforeRevision: last.revision,
            })
          : null;
      return Object.freeze({
        items: Object.freeze(page.map(publicHistory)),
        nextCursor,
      });
    },

    async rollback(
      scopeInput: MarkdownLibraryScope,
      id: string,
      targetRevision: number,
    ): Promise<MarkdownDocumentMetadataV1> {
      const { scope, snapshot } = await read(scopeInput);
      const document = snapshot.documents.find((candidate) => candidate.documentId === id);
      const target = snapshot.revisions.find(
        (revision) => revision.documentId === id && revision.revision === targetRevision,
      );
      if (!document || !target || target.revision === document.revision) {
        throw new Error('markdown_library_revision_unavailable');
      }
      const currentContent = await invokeScopeDependency(scope, () =>
        input.filePort.readText({
          path: document.path,
          root: scope.root,
        }),
      );
      if (
        currentContent === null ||
        (await sha256Text(currentContent)) !== document.contentSha256
      ) {
        throw new Error('markdown_library_file_stale');
      }
      if (target.contentSha256 === document.contentSha256) {
        throw new Error('markdown_library_revision_current');
      }
      const createdAt = now();
      const nextRevisionNumber = document.revision + 1;
      const rolledBack = parseMarkdownDocumentMetadata({
        ...document,
        contentSha256: target.contentSha256,
        sizeBytes: target.sizeBytes,
        revision: nextRevisionNumber,
        indexedAt: createdAt,
      });
      const revision = parseMarkdownRevision({
        schemaVersion: 1,
        documentId: document.documentId,
        revision: nextRevisionNumber,
        contentSha256: target.contentSha256,
        sizeBytes: target.sizeBytes,
        createdAt,
        content: target.content,
      });
      if (!rolledBack || !revision) throw new Error('markdown_library_rollback_invalid');
      const preparation = parseMarkdownRollbackPreparation({
        schemaVersion: 1,
        documentId: document.documentId,
        fromRevision: document.revision,
        targetRevision: target.revision,
        createdAt,
      });
      if (!preparation) throw new Error('markdown_library_rollback_invalid');
      const preparedNext = await validSnapshot(
        Object.freeze({
          generation: snapshot.generation + 1,
          documents: snapshot.documents,
          revisions: snapshot.revisions,
          pendingRollback: preparation,
        }),
        scope,
      );
      let prepared = false;
      try {
        prepared = await invokeScopeDependency(scope, () =>
          input.repository.replaceProjectIndex({
            scope,
            expectedGeneration: snapshot.generation,
            next: preparedNext,
          }),
        );
      } catch {
        prepared = false;
      }
      let preparedSnapshot = preparedNext;
      if (!prepared) {
        const observed = await readSnapshot(scope);
        if (!samePreparation(observed.pendingRollback, preparation)) {
          throw new Error('markdown_library_index_conflict');
        }
        preparedSnapshot = observed;
      }

      let wroteTarget = false;
      try {
        wroteTarget = await invokeScopeDependency(scope, () =>
          input.filePort.compareAndWrite({
            path: document.path,
            root: scope.root,
            expectedSha256: document.contentSha256,
            content: target.content,
          }),
        );
      } catch {
        wroteTarget = false;
      }
      if (!wroteTarget) {
        await recoverPendingRollback(scope, preparedSnapshot);
        throw new Error('markdown_library_file_stale');
      }

      const finalized = await validSnapshot(
        Object.freeze({
          generation: preparedSnapshot.generation + 1,
          documents: Object.freeze(
            preparedSnapshot.documents.map((candidate) =>
              candidate.documentId === document.documentId ? rolledBack : candidate,
            ),
          ),
          revisions: Object.freeze([...preparedSnapshot.revisions, revision]),
          pendingRollback: null,
        }),
        scope,
      );
      let finalizedRepository = false;
      try {
        finalizedRepository = await invokeScopeDependency(scope, () =>
          input.repository.replaceProjectIndex({
            scope,
            expectedGeneration: preparedSnapshot.generation,
            next: finalized,
          }),
        );
      } catch {
        finalizedRepository = false;
      }
      if (finalizedRepository) return rolledBack;

      const observed = await readSnapshot(scope);
      const observedDocument = observed.documents.find(
        (candidate) => candidate.documentId === document.documentId,
      );
      const observedContent = observedDocument
        ? await invokeScopeDependency(scope, () =>
            input.filePort.readText({ path: observedDocument.path, root: scope.root }),
          )
        : null;
      if (
        !observed.pendingRollback &&
        observedDocument?.revision === rolledBack.revision &&
        observedDocument.contentSha256 === rolledBack.contentSha256 &&
        observedContent !== null &&
        (await sha256Text(observedContent)) === rolledBack.contentSha256
      ) {
        return rolledBack;
      }
      if (samePreparation(observed.pendingRollback, preparation)) {
        await recoverPendingRollback(scope, observed);
        throw new Error('markdown_library_index_conflict');
      }
      throw new Error('markdown_library_rollback_recovery_failed');
    },
  });

  return Object.freeze({
    reindex(scopeInput: MarkdownLibraryScope) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.reindex(scope));
    },
    list(
      scopeInput: MarkdownLibraryScope,
      filter: Readonly<{
        query?: string;
        kind?: MarkdownLibraryDocumentKind;
        limit?: number;
      }> = {},
    ) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.list(scope, filter));
    },
    create(scopeInput: MarkdownLibraryScope, draft: Readonly<{ title: string; body: string }>) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.create(scope, draft));
    },
    open(scopeInput: MarkdownLibraryScope, id: string) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.open(scope, id));
    },
    save(scopeInput: MarkdownLibraryScope, id: string, expectedRevision: number, content: string) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () =>
        authority.save(scope, id, expectedRevision, content),
      );
    },
    revisionContent(scopeInput: MarkdownLibraryScope, id: string, revision: number) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.revisionContent(scope, id, revision));
    },
    history(
      scopeInput: MarkdownLibraryScope,
      id: string,
      options: Readonly<{ limit?: number; cursor?: MarkdownHistoryCursorV1 }> = {},
    ) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.history(scope, id, options));
    },
    rollback(scopeInput: MarkdownLibraryScope, id: string, targetRevision: number) {
      const scope = normalizeScope(scopeInput);
      return serializeScopeOperation(scope, () => authority.rollback(scope, id, targetRevision));
    },
  });
}
