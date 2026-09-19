import type { ProviderErrorDetails } from '@/lib/ai/providerError';
import type { PublicToolDetails } from '@/lib/ai/adapters/types';

export type TurnStatus =
  | 'preparing'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface TurnIdentity {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  chatId: string;
  runId: string;
  requestId: string;
  attempt: number;
}

export interface TurnProviderBinding {
  connectionId?: string;
  providerId: string;
  modelId: string;
  sessionId?: string;
}

export interface TurnContextPlan {
  mode: 'direct' | 'retrieval' | 'rlm';
  rlmEnabled: boolean;
  citationsRequired: boolean;
  recursiveChildCallsAllowed: boolean;
  activePaths?: readonly string[];
  exactIdentifiers?: readonly string[];
}

export type TurnPreviewSegment =
  | Readonly<{ kind: 'text'; id: string; text: string }>
  | Readonly<{
      kind: 'tool';
      id: string;
      name: string;
      status: 'started' | 'completed' | 'failed' | 'interrupted';
      fileLabel?: string;
      details?: Readonly<PublicToolDetails>;
    }>;

export interface TurnPublicSnapshot {
  text: string;
  segments: readonly TurnPreviewSegment[];
  updatedAt: number;
  projectRoot?: string;
  publicationRevision?: number;
  runPublicationSequence?: number;
  publicationMonotonicMs?: number;
}

export interface CanonicalTurnState {
  identity: Readonly<TurnIdentity>;
  revision: number;
  status: TurnStatus;
  provider?: Readonly<TurnProviderBinding>;
  contextPlan?: Readonly<TurnContextPlan>;
  reasoning: string;
  public: Readonly<TurnPublicSnapshot>;
  error?: Readonly<ProviderErrorDetails>;
  errorCode?: string;
  cancellationKey?: string;
  acceptedAt: number;
  firstProviderEventAt?: number;
  firstPublicTextAt?: number;
  terminalAt?: number;
}

export type TurnEvent =
  | Readonly<{ type: 'turn.accepted'; identity: TurnIdentity; at: number; cancellationKey?: string }>
  | Readonly<{ type: 'turn.running'; at: number; cancellationKey?: string }>
  | Readonly<{ type: 'turn.failed'; at: number; errorCode?: string }>
  | Readonly<{ type: 'provider.bound'; at: number; provider: TurnProviderBinding }>
  | Readonly<{ type: 'turn.context_planned'; at: number; plan: TurnContextPlan }>
  | Readonly<{ type: 'reasoning.delta'; at: number; text: string; mode?: 'append' | 'replace' }>
  | Readonly<{ type: 'public.snapshot'; at: number; snapshot: TurnPublicSnapshot }>
  | Readonly<{ type: 'public.cleared'; at: number }>
  | Readonly<{ type: 'provider.error'; at: number; error: Readonly<ProviderErrorDetails> }>
  | Readonly<{ type: 'turn.completed'; at: number }>
  | Readonly<{ type: 'turn.cancelled'; at: number }>
  | Readonly<{ type: 'turn.interrupted'; at: number; reason?: string }>;

export const TERMINAL_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}
