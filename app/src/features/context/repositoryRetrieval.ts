import type {
  ContextEdgeV2,
  ContextGraphSnapshotV2,
  ContextProvenanceV2,
  ContextSourceV2,
} from './contracts';
import {
  createStructuralRepositoryService,
  type RepositorySelectionReason,
  type StructuralParserPort,
  type StructuralRepositoryFile,
  type StructuralRepositoryService,
} from '@/features/repository-intelligence';

const MAX_CANDIDATES = 24;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOKEN_BUDGET = 12_000;
const PORTABLE_PATH =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f]).{1,4096}$/u;
const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/u;
const SECRET_PATH =
  /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|ed25519)$|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|p12|pfx|key))$/iu;
const GENERATED_PATH =
  /(?:^|\/)(?:dist|build|coverage|target|node_modules|vendor|generated)(?:\/|$)|(?:\.min\.js|\.map|lock)$/iu;

export interface RepositoryRetrievalFileMetadata {
  path: string;
  contentHash: `sha256:${string}`;
  byteLength: number;
  language: string;
  ignored: boolean;
  generated: boolean;
  secretRisk: boolean;
  trusted: boolean;
}

export interface RepositoryRetrievalFileRead extends RepositoryRetrievalFileMetadata {
  content: string;
}

export interface RepositoryRetrievalDependencies {
  loadActiveContextMap(input: {
    accountId: string;
    projectId: string;
    mapId?: string;
  }): Promise<Readonly<ContextGraphSnapshotV2> | null>;
  resolveRepository(input: {
    accountId: string;
    projectId: string;
  }): Promise<
    Readonly<{
      rootId: string;
      repositoryRevision: string;
      sourceIds: readonly string[];
    }> | null
  >;
  inspectFiles(input: {
    rootId: string;
    paths: readonly string[];
  }): Promise<readonly Readonly<RepositoryRetrievalFileMetadata>[]>;
  readFile(input: {
    rootId: string;
    path: string;
    maximumBytes: number;
    expectedContentHash: string;
  }): Promise<Readonly<RepositoryRetrievalFileRead>>;
  countTokens(text: string): Promise<number>;
  parser: StructuralParserPort;
  maximumCandidates?: number;
}

export interface RepositoryRetrievalRequest {
  accountId: string;
  projectId: string;
  mapId?: string;
  taskText: string;
  tokenBudget: number;
  activePaths?: readonly string[];
  explicitEntityIds?: readonly string[];
}

export interface RepositoryRetrievalEvidence {
  mapId: string;
  entityId: string;
  sourceId: string;
  provenanceId: string;
  sourceRevision: string;
  repositoryRevision: string;
  contentHash: string;
  astHash: string;
  parserId: string;
  parserVersion: string;
}

export interface RepositoryRetrievalItem {
  path: string;
  language: string;
  representation: 'full' | 'signatures' | 'metadata';
  content: string;
  tokens: number;
  whySelected: readonly RepositorySelectionReason[];
  symbols: readonly Readonly<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    exported: boolean;
  }>[];
  evidence: Readonly<RepositoryRetrievalEvidence>;
}

export interface RepositoryRetrievalRelationship {
  sourceEntityId: string;
  targetEntityId: string;
  kind: string;
  evidence: Readonly<{
    provenanceId: string;
    sourceId: string;
    sourceRevision: string;
    confidence: number;
  }>;
}

export interface RepositoryRetrievalResult {
  mapId: string;
  repositoryRevision: string;
  structuralRevision: number;
  items: readonly Readonly<RepositoryRetrievalItem>[];
  relationships: readonly Readonly<RepositoryRetrievalRelationship>[];
  exclusions: readonly Readonly<{ path: string; reason: string }>[];
  totalTokens: number;
  remainingTokens: number;
  parsedChangedPaths: readonly string[];
}

type Candidate = Readonly<{
  entity: ContextGraphSnapshotV2['entities'][number];
  source: ContextSourceV2;
  provenance: ContextProvenanceV2;
  lexicalRelevance: number;
  taskRelevance: number;
  explicit: boolean;
  active: boolean;
  importedByActiveFile: boolean;
  incomingReferences: number;
  outgoingReferences: number;
  metadataScore: number;
}>;

function stableText(value: unknown, maximum = 4_096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function terms(value: string): readonly string[] {
  return Object.freeze([
    ...new Set(value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]{2,}/gu) ?? []),
  ].slice(0, 64));
}

function relevance(path: string, summary: string | undefined, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const haystack = `${path}\n${summary ?? ''}`.toLocaleLowerCase('en-US');
  return Math.min(1, queryTerms.filter((term) => haystack.includes(term)).length / queryTerms.length);
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && PORTABLE_PATH.test(path);
}

async function hashContent(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function languageSupported(language: string): boolean {
  return ['typescript', 'tsx', 'javascript', 'jsx', 'rust', 'python', 'json'].includes(language);
}

function exactEntityEvidence(
  snapshot: Readonly<ContextGraphSnapshotV2>,
  entity: ContextGraphSnapshotV2['entities'][number],
): ContextProvenanceV2 | undefined {
  return snapshot.provenance.find(
    (entry) =>
      entry.targetKind === 'entity' &&
      entry.targetId === entity.id &&
      entry.accountId === snapshot.map.accountId &&
      entry.mapId === snapshot.map.id &&
      entry.sourceId === entity.sourceId &&
      entry.path === entity.path &&
      entry.sourceRevision === entity.sourceRevision,
  );
}

function rankCandidates(
  snapshot: Readonly<ContextGraphSnapshotV2>,
  request: Readonly<RepositoryRetrievalRequest>,
  maximum: number,
): readonly Candidate[] {
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const activePaths = new Set(request.activePaths ?? []);
  const explicitIds = new Set(request.explicitEntityIds ?? []);
  const queryTerms = terms(request.taskText);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const importedFromActive = new Set<string>();
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  for (const edge of snapshot.edges) {
    outgoing.set(edge.sourceEntityId, (outgoing.get(edge.sourceEntityId) ?? 0) + 1);
    incoming.set(edge.targetEntityId, (incoming.get(edge.targetEntityId) ?? 0) + 1);
    const source = entityById.get(edge.sourceEntityId);
    if (source?.path && activePaths.has(source.path)) importedFromActive.add(edge.targetEntityId);
  }

  const candidates: Candidate[] = [];
  for (const entity of snapshot.entities) {
    if (entity.kind !== 'file' || !validPath(entity.path)) continue;
    const source = sourceById.get(entity.sourceId);
    const provenance = exactEntityEvidence(snapshot, entity);
    if (
      !source ||
      !provenance ||
      entity.accountId !== request.accountId ||
      entity.mapId !== snapshot.map.id ||
      source.accountId !== request.accountId ||
      source.mapId !== snapshot.map.id ||
      !['local_folder', 'github_repository'].includes(source.kind)
    ) {
      continue;
    }
    const lexicalRelevance = relevance(entity.path, entity.summary, queryTerms);
    const explicit = explicitIds.has(entity.id);
    const active = activePaths.has(entity.path);
    const importedByActiveFile = importedFromActive.has(entity.id);
    const incomingReferences = incoming.get(entity.id) ?? 0;
    const outgoingReferences = outgoing.get(entity.id) ?? 0;
    candidates.push({
      entity,
      source,
      provenance,
      lexicalRelevance,
      taskRelevance: lexicalRelevance,
      explicit,
      active,
      importedByActiveFile,
      incomingReferences,
      outgoingReferences,
      metadataScore:
        (explicit ? 1_000 : 0) +
        (active ? 500 : 0) +
        (importedByActiveFile ? 250 : 0) +
        lexicalRelevance * 100 +
        Math.log2(incomingReferences * 2 + outgoingReferences + 1) * 10,
    });
  }
  return Object.freeze(
    candidates
      .sort(
        (left, right) =>
          right.metadataScore - left.metadataScore ||
          left.entity.path!.localeCompare(right.entity.path!, 'en-US'),
      )
      .slice(0, maximum),
  );
}

function signatureContent(content: string, symbols: RepositoryRetrievalItem['symbols']): string {
  const lines = content.split(/\r?\n/u);
  return symbols
    .slice(0, 80)
    .map((symbol) => {
      const line = lines[symbol.startLine - 1]?.trim() ?? '';
      return `${symbol.kind} ${symbol.name} @${symbol.startLine}-${symbol.endLine}: ${line}`;
    })
    .join('\n');
}

function metadataContent(
  path: string,
  language: string,
  symbols: RepositoryRetrievalItem['symbols'],
): string {
  return `${path} (${language})\n${symbols
    .slice(0, 80)
    .map((symbol) => `${symbol.kind}:${symbol.name}@${symbol.startLine}`)
    .join('\n')}`;
}

function relationshipEvidence(
  snapshot: Readonly<ContextGraphSnapshotV2>,
  edge: ContextEdgeV2,
): ContextProvenanceV2 | undefined {
  return snapshot.provenance.find(
    (entry) =>
      entry.targetKind === 'edge' &&
      entry.targetId === edge.id &&
      entry.accountId === snapshot.map.accountId &&
      entry.mapId === snapshot.map.id &&
      entry.sourceRevision === edge.sourceRevision,
  );
}

export function createRepositoryRetrievalService(
  dependencies: RepositoryRetrievalDependencies,
): Readonly<{
  retrieve(request: RepositoryRetrievalRequest): Promise<Readonly<RepositoryRetrievalResult>>;
}> {
  const configuredMaximum = dependencies.maximumCandidates ?? MAX_CANDIDATES;
  if (
    !Number.isSafeInteger(configuredMaximum) ||
    configuredMaximum < 1 ||
    configuredMaximum > MAX_CANDIDATES
  ) {
    throw new Error('Invalid repository candidate ceiling.');
  }
  const structural: StructuralRepositoryService = createStructuralRepositoryService(
    dependencies.parser,
  );
  const indexedHashes = new Map<string, string>();
  const indexedFiles = new Map<string, Readonly<RepositoryRetrievalFileRead>>();
  const indexedFullTokens = new Map<string, number>();

  return Object.freeze({
    async retrieve(request) {
      if (
        !stableText(request.accountId, 200) ||
        !stableText(request.projectId, 200) ||
        (request.mapId !== undefined && !stableText(request.mapId, 200)) ||
        !stableText(request.taskText, 32_768) ||
        !Number.isSafeInteger(request.tokenBudget) ||
        request.tokenBudget < 1 ||
        request.tokenBudget > MAX_TOKEN_BUDGET ||
        (request.activePaths ?? []).some((path) => !validPath(path)) ||
        (request.explicitEntityIds ?? []).some((id) => !stableText(id, 200))
      ) {
        throw new Error('Invalid repository retrieval request.');
      }
      const [snapshot, repository] = await Promise.all([
        dependencies.loadActiveContextMap({
          accountId: request.accountId,
          projectId: request.projectId,
          ...(request.mapId === undefined ? {} : { mapId: request.mapId }),
        }),
        dependencies.resolveRepository({
          accountId: request.accountId,
          projectId: request.projectId,
        }),
      ]);
      if (!snapshot || !repository) throw new Error('Active repository Context Map unavailable.');
      if (
        snapshot.map.status !== 'active' ||
        snapshot.map.accountId !== request.accountId ||
        snapshot.map.projectId !== request.projectId ||
        (request.mapId !== undefined && snapshot.map.id !== request.mapId) ||
        !stableText(repository.rootId, 1_000) ||
        !stableText(repository.repositoryRevision, 1_000) ||
        !Array.isArray(repository.sourceIds) ||
        repository.sourceIds.length === 0 ||
        new Set(repository.sourceIds).size !== repository.sourceIds.length ||
        repository.sourceIds.some((sourceId) => !stableText(sourceId, 200))
      ) {
        throw new Error('Repository Context Map authority mismatch.');
      }

      const maximum = configuredMaximum;
      const candidates = rankCandidates(snapshot, request, maximum);
      const paths = candidates.map((candidate) => candidate.entity.path!);
      const metadata = [...(await dependencies.inspectFiles({ rootId: repository.rootId, paths }))];
      if (
        metadata.length !== paths.length ||
        new Set(metadata.map((file) => file.path)).size !== metadata.length ||
        metadata.some((file) => !paths.includes(file.path))
      ) {
        throw new Error('Repository metadata result did not match the bounded candidate set.');
      }
      const metadataByPath = new Map(metadata.map((file) => [file.path, file]));
      const exclusions: Array<{ path: string; reason: string }> = [];
      const eligible: Candidate[] = [];
      for (const candidate of candidates) {
        const path = candidate.entity.path!;
        const file = metadataByPath.get(path)!;
        let reason: string | undefined;
        if (
          !validPath(file.path) ||
          !Number.isSafeInteger(file.byteLength) ||
          typeof file.ignored !== 'boolean' ||
          typeof file.generated !== 'boolean' ||
          typeof file.secretRisk !== 'boolean' ||
          typeof file.trusted !== 'boolean'
        )
          reason = 'invalid_metadata';
        else if (!repository.sourceIds.includes(candidate.source.id))
          reason = 'source_outside_repository';
        else if (
          candidate.entity.sourceRevision !== repository.repositoryRevision ||
          candidate.provenance.sourceRevision !== repository.repositoryRevision ||
          (candidate.source.sourceRevision !== undefined &&
            candidate.source.sourceRevision !== repository.repositoryRevision)
        )
          reason = 'stale_evidence';
        else if (!CONTENT_HASH.test(file.contentHash) || file.byteLength < 0)
          reason = 'invalid_metadata';
        else if (file.byteLength > MAX_FILE_BYTES) reason = 'file_too_large';
        else if (!languageSupported(file.language)) reason = 'unsupported_language';
        else if (file.ignored) reason = 'ignored';
        else if (file.generated || GENERATED_PATH.test(path)) reason = 'generated';
        else if (file.secretRisk || SECRET_PATH.test(path)) reason = 'secret_risk';
        else if (!file.trusted) reason = 'untrusted';
        if (reason) exclusions.push({ path, reason });
        else eligible.push(candidate);
      }

      const reads = await Promise.all(
        eligible.map(async (candidate) => {
          const path = candidate.entity.path!;
          const expected = metadataByPath.get(path)!;
          const file = await dependencies.readFile({
            rootId: repository.rootId,
            path,
            maximumBytes: MAX_FILE_BYTES,
            expectedContentHash: expected.contentHash,
          });
          if (
            file.path !== path ||
            file.contentHash !== expected.contentHash ||
            file.language !== expected.language ||
            file.ignored !== expected.ignored ||
            file.generated !== expected.generated ||
            file.secretRisk !== expected.secretRisk ||
            file.trusted !== expected.trusted ||
            file.byteLength !== new TextEncoder().encode(file.content).byteLength ||
            file.byteLength !== expected.byteLength ||
            file.byteLength > MAX_FILE_BYTES ||
            (await hashContent(file.content)) !== file.contentHash
          ) {
            throw new Error(`Repository read evidence mismatch for ${path}.`);
          }
          return Object.freeze({ ...file });
        }),
      );
      const currentPaths = new Set(reads.map((file) => file.path));
      const deletedPaths = [...indexedHashes.keys()].filter((path) => !currentPaths.has(path));
      const changedFiles: StructuralRepositoryFile[] = [];
      for (const file of reads) {
        if (indexedHashes.get(file.path) !== file.contentHash) {
          const fullTokens = await dependencies.countTokens(file.content);
          changedFiles.push({
            path: file.path,
            language: file.language,
            content: file.content,
            contentHash: file.contentHash,
            fullTokens,
            trusted: file.trusted,
            ignored: file.ignored,
            generated: file.generated,
            secretRisk: file.secretRisk,
          });
          indexedFullTokens.set(file.path, fullTokens);
        }
        indexedFiles.set(file.path, file);
        indexedHashes.set(file.path, file.contentHash);
      }
      for (const path of deletedPaths) {
        indexedFiles.delete(path);
        indexedHashes.delete(path);
        indexedFullTokens.delete(path);
      }
      const structuralSnapshot = await structural.update({
        repositoryCommit: repository.repositoryRevision,
        changedFiles,
        deletedPaths,
      });
      const parseByPath = new Map(structuralSnapshot.files.map((file) => [file.path, file]));
      const signalByPath = Object.fromEntries(
        eligible.map((candidate) => [
          candidate.entity.path!,
          {
            lexicalRelevance: candidate.lexicalRelevance,
            taskRelevance: candidate.taskRelevance,
            explicit: candidate.explicit,
            active: candidate.active,
            importedByActiveFile: candidate.importedByActiveFile,
          },
        ]),
      );
      const policyByPath = Object.fromEntries(
        reads.map((file) => [
          file.path,
          {
            fullTokens:
              indexedFullTokens.get(file.path) ??
              Math.max(parseByPath.get(file.path)?.signatureTokens ?? 0, 1),
            trusted: file.trusted,
            ignored: file.ignored,
            generated: file.generated,
            secretRisk: file.secretRisk,
          },
        ]),
      );
      const pack = structural.buildContext({
        tokenBudget: request.tokenBudget,
        signals: signalByPath,
        filePolicies: policyByPath,
      });
      exclusions.push(...pack.exclusions);

      const candidateByPath = new Map(eligible.map((candidate) => [candidate.entity.path!, candidate]));
      const items: RepositoryRetrievalItem[] = [];
      let totalTokens = 0;
      for (const entry of pack.entries) {
        const file = indexedFiles.get(entry.path);
        const parsed = parseByPath.get(entry.path);
        const candidate = candidateByPath.get(entry.path);
        if (!file || !parsed || !candidate) continue;
        const content =
          entry.representation === 'full'
            ? file.content
            : entry.representation === 'signatures'
              ? signatureContent(file.content, parsed.symbols)
              : metadataContent(file.path, file.language, parsed.symbols);
        const tokens = await dependencies.countTokens(content);
        if (totalTokens + tokens > request.tokenBudget) {
          exclusions.push({ path: entry.path, reason: 'over_budget' });
          continue;
        }
        totalTokens += tokens;
        items.push({
          path: entry.path,
          language: entry.language,
          representation: entry.representation,
          content,
          tokens,
          whySelected: Object.freeze([...entry.reasons]),
          symbols: Object.freeze(parsed.symbols.map((symbol) => Object.freeze({ ...symbol }))),
          evidence: Object.freeze({
            mapId: snapshot.map.id,
            entityId: candidate.entity.id,
            sourceId: candidate.entity.sourceId,
            provenanceId: candidate.provenance.id,
            sourceRevision: candidate.entity.sourceRevision,
            repositoryRevision: repository.repositoryRevision,
            contentHash: file.contentHash,
            astHash: parsed.astHash,
            parserId: parsed.parserId,
            parserVersion: parsed.parserVersion,
          }),
        });
      }
      const selectedIds = new Set(items.map((item) => item.evidence.entityId));
      const relationships: RepositoryRetrievalRelationship[] = [];
      for (const edge of snapshot.edges) {
        if (
          edge.accountId !== request.accountId ||
          edge.mapId !== snapshot.map.id ||
          edge.sourceRevision !== repository.repositoryRevision ||
          !selectedIds.has(edge.sourceEntityId) ||
          !selectedIds.has(edge.targetEntityId)
        )
          continue;
        const evidence = relationshipEvidence(snapshot, edge);
        if (!evidence) continue;
        relationships.push({
          sourceEntityId: edge.sourceEntityId,
          targetEntityId: edge.targetEntityId,
          kind: edge.kind,
          evidence: Object.freeze({
            provenanceId: evidence.id,
            sourceId: evidence.sourceId,
            sourceRevision: evidence.sourceRevision,
            confidence: edge.confidence,
          }),
        });
      }
      return Object.freeze({
        mapId: snapshot.map.id,
        repositoryRevision: repository.repositoryRevision,
        structuralRevision: structuralSnapshot.revision,
        items: Object.freeze(items.map((item) => Object.freeze(item))),
        relationships: Object.freeze(relationships.map((item) => Object.freeze(item))),
        exclusions: Object.freeze(exclusions.map((item) => Object.freeze(item))),
        totalTokens,
        remainingTokens: request.tokenBudget - totalTokens,
        parsedChangedPaths: Object.freeze(changedFiles.map((file) => file.path).sort()),
      });
    },
  });
}
