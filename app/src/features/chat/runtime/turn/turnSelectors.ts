import type { CanonicalTurnState, TurnPreviewSegment } from './turnTypes';

const previewProjectionCache = new WeakMap<CanonicalTurnState, Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  chatId: string;
  text: string;
  segments: readonly TurnPreviewSegment[];
  updatedAt: number;
  projectRoot?: string;
  publicationRevision?: number;
  runPublicationSequence?: number;
  publicationMonotonicMs?: number;
}>>();

export function selectTurnThinking(turn: CanonicalTurnState | null | undefined): boolean {
  if (!turn) return false;
  return (
    turn.status === 'preparing' ||
    turn.status === 'running' ||
    turn.status === 'awaiting_approval'
  );
}

export function selectTurnPreview(turn: CanonicalTurnState | null | undefined):
  | Readonly<{
      accountId: string;
      runId: string;
      requestId: string;
      chatId: string;
      text: string;
      segments: readonly TurnPreviewSegment[];
      updatedAt: number;
      projectRoot?: string;
      publicationRevision?: number;
      runPublicationSequence?: number;
      publicationMonotonicMs?: number;
    }>
  | null {
  if (!turn) return null;
  const cached = previewProjectionCache.get(turn);
  if (cached) return cached;
  const projected = Object.freeze({
    accountId: turn.identity.accountId,
    runId: turn.identity.runId,
    requestId: turn.identity.requestId,
    chatId: turn.identity.chatId,
    ...turn.public,
  });
  previewProjectionCache.set(turn, projected);
  return projected;
}

export function selectAgenticSessionEvidence(
  turn: CanonicalTurnState | null | undefined,
):
  | Readonly<{
      status: string;
      currentOperation: string;
      model?: string;
      startedAt: number;
      endedAt?: number;
    }>
  | undefined {
  if (!turn) return undefined;
  const status =
    turn.status === 'completed'
      ? 'completed'
      : turn.status === 'failed' || turn.status === 'interrupted'
        ? 'error'
        : turn.status;
  return Object.freeze({
    status,
    currentOperation:
      status === 'error'
        ? turn.error?.message ?? 'Failed'
        : status === 'cancelled'
          ? 'Cancelled'
          : status.replaceAll('_', ' '),
    ...(turn.provider?.modelId ? { model: turn.provider.modelId } : {}),
    startedAt: turn.acceptedAt,
    ...(turn.terminalAt ? { endedAt: turn.terminalAt } : {}),
  });
}
