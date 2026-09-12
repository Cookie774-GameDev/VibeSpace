import type {
  RepositoryCandidate,
  RepositoryContextPack,
  RepositorySymbolFact,
} from './contracts';
import { buildRepositoryContextPack } from './packer';

export interface StructuralRepositoryFile {
  path: string;
  language: string;
  content: string;
  contentHash: string;
  fullTokens: number;
  trusted: boolean;
  ignored: boolean;
  generated: boolean;
  secretRisk: boolean;
}

export interface StructuralParseResult {
  path: string;
  language: string;
  contentHash: string;
  signatureTokens: number;
  metadataTokens: number;
  symbols: readonly RepositorySymbolFact[];
  incomingReferences: number;
  outgoingReferences: number;
  parserId: string;
  parserVersion: string;
  astHash: string;
}

export interface StructuralParserPort {
  parse(file: Readonly<StructuralRepositoryFile>): Promise<StructuralParseResult>;
}

export interface RepositoryTaskSignals {
  lexicalRelevance?: number;
  taskRelevance?: number;
  explicit?: boolean;
  active?: boolean;
  importedByActiveFile?: boolean;
  userPinned?: boolean;
}

export interface StructuralRepositorySnapshot {
  revision: number;
  repositoryCommit: string;
  files: readonly Readonly<StructuralParseResult>[];
}

export interface StructuralRepositoryService {
  update(input: {
    repositoryCommit: string;
    changedFiles: readonly StructuralRepositoryFile[];
    deletedPaths: readonly string[];
  }): Promise<StructuralRepositorySnapshot>;
  snapshot(): StructuralRepositorySnapshot;
  buildContext(input: {
    tokenBudget: number;
    signals: Readonly<Record<string, RepositoryTaskSignals>>;
    filePolicies: Readonly<
      Record<
        string,
        Pick<
          StructuralRepositoryFile,
          'fullTokens' | 'trusted' | 'ignored' | 'generated' | 'secretRisk'
        >
      >
    >;
  }): RepositoryContextPack;
}

function validateParse(
  requested: StructuralRepositoryFile,
  result: StructuralParseResult,
): StructuralParseResult {
  if (
    result.path !== requested.path ||
    result.language !== requested.language ||
    result.contentHash !== requested.contentHash ||
    !result.parserId ||
    !result.parserVersion ||
    !result.astHash ||
    !Number.isSafeInteger(result.signatureTokens) ||
    !Number.isSafeInteger(result.metadataTokens) ||
    result.metadataTokens < 0 ||
    result.signatureTokens < result.metadataTokens ||
    result.signatureTokens > requested.fullTokens
  ) {
    throw new Error(`Invalid structural parser result for ${requested.path}.`);
  }
  return Object.freeze({
    ...result,
    symbols: Object.freeze([...result.symbols]),
  });
}

export function createStructuralRepositoryService(
  parser: StructuralParserPort,
): StructuralRepositoryService {
  const files = new Map<string, Readonly<StructuralParseResult>>();
  let revision = 0;
  let repositoryCommit = '';

  const snapshot = (): StructuralRepositorySnapshot =>
    Object.freeze({
      revision,
      repositoryCommit,
      files: Object.freeze(
        [...files.values()].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
      ),
    });

  return {
    async update(input) {
      if (!input.repositoryCommit) throw new Error('Repository commit is required.');
      const changedPaths = new Set<string>();
      const deletedPaths = new Set<string>();
      for (const file of input.changedFiles) {
        if (!file.path || changedPaths.has(file.path)) {
          throw new Error(`Duplicate or invalid changed repository path ${file.path}.`);
        }
        changedPaths.add(file.path);
      }
      for (const path of input.deletedPaths) {
        if (!path || changedPaths.has(path) || deletedPaths.has(path)) {
          throw new Error(`Conflicting deleted repository path ${path}.`);
        }
        deletedPaths.add(path);
      }

      const parsed = await Promise.all(
        input.changedFiles.map(async (file) => {
          const existing = files.get(file.path);
          if (existing?.contentHash === file.contentHash) return existing;
          return validateParse(file, await parser.parse(Object.freeze({ ...file })));
        }),
      );
      const nextFiles = new Map(files);
      for (const path of deletedPaths) nextFiles.delete(path);
      for (const result of parsed) {
        nextFiles.set(result.path, result);
      }
      files.clear();
      for (const [path, result] of nextFiles) files.set(path, result);
      repositoryCommit = input.repositoryCommit;
      revision += 1;
      return snapshot();
    },
    snapshot,
    buildContext(input) {
      const candidates: RepositoryCandidate[] = [...files.values()].map((file) => {
        const policy = input.filePolicies[file.path];
        if (!policy) throw new Error(`Missing repository file policy for ${file.path}.`);
        const signals = input.signals[file.path] ?? {};
        return {
          path: file.path,
          projectRelative: true,
          language: file.language,
          fullTokens: policy.fullTokens,
          signatureTokens: file.signatureTokens,
          metadataTokens: file.metadataTokens,
          lexicalRelevance: signals.lexicalRelevance ?? 0,
          taskRelevance: signals.taskRelevance ?? 0,
          incomingReferences: file.incomingReferences,
          outgoingReferences: file.outgoingReferences,
          explicit: signals.explicit ?? false,
          active: signals.active ?? false,
          importedByActiveFile: signals.importedByActiveFile ?? false,
          userPinned: signals.userPinned ?? false,
          trusted: policy.trusted,
          ignored: policy.ignored,
          generated: policy.generated,
          secretRisk: policy.secretRisk,
          symbols: file.symbols,
        };
      });
      return buildRepositoryContextPack({ candidates, tokenBudget: input.tokenBudget });
    },
  };
}
