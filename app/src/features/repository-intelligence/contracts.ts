export interface RepositorySymbolFact {
  name: string;
  kind: 'function' | 'class' | 'method' | 'component' | 'type' | 'constant' | 'module';
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface RepositoryCandidate {
  path: string;
  projectRelative: boolean;
  language: string;
  fullTokens: number;
  signatureTokens: number;
  metadataTokens: number;
  lexicalRelevance: number;
  taskRelevance: number;
  incomingReferences: number;
  outgoingReferences: number;
  explicit: boolean;
  active: boolean;
  importedByActiveFile: boolean;
  userPinned: boolean;
  trusted: boolean;
  ignored: boolean;
  generated: boolean;
  secretRisk: boolean;
  symbols: readonly RepositorySymbolFact[];
}

export type RepositorySelectionReason =
  | 'explicitly_selected'
  | 'user_pinned'
  | 'active_file'
  | 'imported_by_active_file'
  | 'task_relevance'
  | 'lexical_relevance'
  | 'reference_centrality';

export interface RankedRepositoryCandidate extends RepositoryCandidate {
  score: number;
  reasons: readonly RepositorySelectionReason[];
}

export type RepositoryRepresentation = 'full' | 'signatures' | 'metadata';

export interface RepositoryContextEntry {
  path: string;
  language: string;
  representation: RepositoryRepresentation;
  tokens: number;
  score: number;
  reasons: readonly RepositorySelectionReason[];
  symbols: readonly RepositorySymbolFact[];
}

export type RepositoryExclusionReason =
  | 'outside_project'
  | 'ignored'
  | 'generated'
  | 'secret_risk'
  | 'untrusted'
  | 'irrelevant'
  | 'over_budget';

export interface RepositoryContextPack {
  entries: readonly RepositoryContextEntry[];
  exclusions: readonly Readonly<{ path: string; reason: RepositoryExclusionReason }>[];
  totalTokens: number;
  remainingTokens: number;
}
