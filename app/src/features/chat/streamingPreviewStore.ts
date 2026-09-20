import type { TurnPreviewSegment } from './runtime/turn/turnTypes';
import {
  clearAccountPublicSnapshots,
  clearTurn,
  clearTurnPublic,
  getLatestTurn,
  getTurn,
  publishTurnPublicSnapshot,
  subscribeTurnChat,
  subscribeTurnChatPriority,
  subscribeTurns,
} from './runtime/turn/turnStore';
import { isTerminalTurnStatus } from './runtime/turn/turnTypes';
import { selectTurnPreview } from './runtime/turn/turnSelectors';

export type StreamingPreviewSegment = TurnPreviewSegment;

export interface StreamingPreviewIdentity {
  accountId: string;
  chatId: string;
  runId: string;
  requestId: string;
}

/**
 * Main provider requests have a durable placeholder but no canonical kernel
 * run identity. Keep their fast preview chat-scoped and collision-safe while
 * the durable assistant message remains the reconciliation authority.
 */
export function previewIdentityForPlaceholder(input: {
  accountId: string;
  chatId: string;
  placeholderId: string | number;
}): StreamingPreviewIdentity {
  const accountId = input.accountId.trim();
  const chatId = input.chatId.trim();
  const requestId = String(input.placeholderId).trim();
  if (!accountId || !chatId || !requestId) throw new Error('invalid_streaming_preview_identity');
  return Object.freeze({ accountId, chatId, requestId, runId: `chat-preview:${requestId}` });
}

export interface JarvisStreamingPreview {
  accountId: string;
  runId: string;
  requestId: string;
  chatId: string;
  text: string;
  segments?: readonly StreamingPreviewSegment[];
  updatedAt: number;
  /** Trusted runtime project root, never supplied by a tool result. */
  projectRoot?: string;
  /** Assigned by the store for correlation with the corresponding DOM commit. */
  publicationRevision?: number;
  /** Per-run publication sequence; coalescing is measured within one run only. */
  runPublicationSequence?: number;
  /** Monotonic renderer time; never a provider timestamp or model latency. */
  publicationMonotonicMs?: number;
}

let publicationRevision = 0;
const runPublicationSequences = new Map<string, number>();

function key(accountId: string, value: string): string {
  return accountId.length + ':' + accountId + value;
}

function requireId(value: string, field: string): void {
  if (!value.trim()) throw new Error('invalid_streaming_preview_' + field);
}

function sameSegments(
  left: JarvisStreamingPreview['segments'],
  right: JarvisStreamingPreview['segments'],
): boolean {
  if (left === right) return true;
  const leftSegments = left ?? [];
  const rightSegments = right ?? [];
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((before, index) => {
    const after = rightSegments[index];
    if (!after || before.kind !== after.kind || before.id !== after.id) return false;
    if (before.kind === 'text' && after.kind === 'text') return before.text === after.text;
    if (before.kind !== 'tool' || after.kind !== 'tool') {
      return (
        before.kind === 'reasoning' && after.kind === 'reasoning' && before.text === after.text
      );
    }
    return (
      before.name === after.name &&
      before.status === after.status &&
      before.fileLabel === after.fileLabel &&
      before.details === after.details
    );
  });
}

function previewFromTurn(
  accountId: string,
  runId: string,
): Readonly<JarvisStreamingPreview> | null {
  const turn = getTurn(accountId, runId);
  const projected = selectTurnPreview(turn);
  if (!projected || (!projected.text && projected.segments.length === 0)) return null;
  return projected as Readonly<JarvisStreamingPreview>;
}

export function subscribeChatPreviews(
  accountId: string,
  chatId: string,
  listener: () => void,
): () => void {
  return subscribeTurnChat(accountId, chatId, listener);
}

export function subscribeFastChatPreviews(
  accountId: string,
  chatId: string,
  listener: (preview: Readonly<JarvisStreamingPreview> | null) => void,
): () => void {
  let previous = getChatPreview(accountId, chatId);
  return subscribeTurnChatPriority(accountId, chatId, () => {
    const next = getChatPreview(accountId, chatId);
    if (
      next === previous ||
      (next?.publicationRevision === previous?.publicationRevision &&
        next?.text === previous?.text &&
        next?.segments === previous?.segments)
    ) {
      return;
    }
    previous = next;
    listener(next);
  });
}

export function subscribePreviews(listener: () => void): () => void {
  return subscribeTurns(listener);
}

export function getChatPreview(
  accountId: string,
  chatId: string,
): Readonly<JarvisStreamingPreview> | null {
  const turn = getLatestTurn(accountId, chatId);
  const projected = selectTurnPreview(turn);
  if (!projected || (!projected.text && projected.segments.length === 0)) return null;
  return projected as Readonly<JarvisStreamingPreview>;
}

export function setPreview(preview: JarvisStreamingPreview): void {
  requireId(preview.accountId, 'account_id');
  requireId(preview.runId, 'run_id');
  requireId(preview.requestId, 'request_id');
  requireId(preview.chatId, 'chat_id');
  if (!Number.isFinite(preview.updatedAt)) throw new Error('invalid_streaming_preview_updated_at');

  const existingTurn = getTurn(preview.accountId, preview.runId);
  const existing = previewFromTurn(preview.accountId, preview.runId);
  if (
    existing?.requestId === preview.requestId &&
    existing.chatId === preview.chatId &&
    existing.text === preview.text &&
    existing.projectRoot === preview.projectRoot &&
    sameSegments(existing.segments, preview.segments)
  ) {
    return;
  }

  // Legacy preview callers may move a request between mounted chat panes or
  // reuse a completed fixture run id. Rebind the presentation-only identity;
  // production canonical runs use stable chat/run identities.
  if (
    existingTurn &&
    (existingTurn.identity.chatId !== preview.chatId ||
      (existingTurn.identity.requestId !== preview.requestId &&
        (isTerminalTurnStatus(existingTurn.status) ||
          (!existingTurn.public.text && existingTurn.public.segments.length === 0))))
  ) {
    clearTurn(preview.accountId, preview.runId);
  }

  const sequenceKey = key(preview.accountId, preview.runId);
  const runPublicationSequence = (runPublicationSequences.get(sequenceKey) ?? 0) + 1;
  runPublicationSequences.set(sequenceKey, runPublicationSequence);

  publishTurnPublicSnapshot({
    identity: {
      accountId: preview.accountId,
      chatId: preview.chatId,
      runId: preview.runId,
      requestId: preview.requestId,
      attempt: 1,
    },
    snapshot: {
      text: preview.text,
      segments: preview.segments ?? [],
      updatedAt: preview.updatedAt,
      ...(preview.projectRoot ? { projectRoot: preview.projectRoot } : {}),
      publicationRevision: ++publicationRevision,
      runPublicationSequence,
      publicationMonotonicMs: performance.now(),
    },
  });
}

export function getPreview(
  accountId: string,
  runId: string,
): Readonly<JarvisStreamingPreview> | null {
  return previewFromTurn(accountId, runId);
}

/** Temporary clears retain turn authority and run status; only public projection is cleared. */
export function clearPreview(
  accountId: string,
  runId: string,
  options: Readonly<{ terminal?: boolean }> = {},
): void {
  const sequenceKey = key(accountId, runId);
  if (options.terminal) runPublicationSequences.delete(sequenceKey);
  clearTurnPublic(accountId, runId);
}

export function clearAccountPreviews(accountId: string): void {
  const accountPrefix = accountId.length + ':' + accountId;
  for (const entryKey of runPublicationSequences.keys()) {
    if (entryKey.startsWith(accountPrefix)) runPublicationSequences.delete(entryKey);
  }
  clearAccountPublicSnapshots(accountId);
}
