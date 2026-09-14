export type StreamingPreviewSegment =
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      status: 'started' | 'completed' | 'failed';
      fileLabel?: string;
      details?: Readonly<import('@/lib/ai/adapters/types').PublicToolDetails>;
    };

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
  /** Monotonic renderer time; never a provider timestamp or model latency. */
  publicationMonotonicMs?: number;
}

const listeners = new Set<() => void>();
const chatListeners = new Map<string, Set<() => void>>();

export function subscribeChatPreviews(
  accountId: string,
  chatId: string,
  listener: () => void,
): () => void {
  const chatKey = key(accountId, chatId);
  let scoped = chatListeners.get(chatKey);
  if (!scoped) {
    scoped = new Set();
    chatListeners.set(chatKey, scoped);
  }
  scoped.add(listener);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0 && chatListeners.get(chatKey) === scoped) chatListeners.delete(chatKey);
  };
}

export function subscribePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notifyPreviews(changedChats: ReadonlySet<string>): void {
  for (const chatKey of changedChats) {
    for (const listener of chatListeners.get(chatKey) ?? []) listener();
  }
  for (const listener of listeners) listener();
}

export function getChatPreview(
  accountId: string,
  chatId: string,
): Readonly<JarvisStreamingPreview> | null {
  let latest: Readonly<JarvisStreamingPreview> | null = null;
  for (const preview of previews.values()) {
    if (
      preview.accountId === accountId &&
      preview.chatId === chatId &&
      (!latest || preview.updatedAt > latest.updatedAt)
    )
      latest = preview;
  }
  return latest;
}

const previews = new Map<string, Readonly<JarvisStreamingPreview>>();
let publicationRevision = 0;

function key(accountId: string, runId: string): string {
  return `${accountId.length}:${accountId}${runId}`;
}

function requireId(value: string, field: string): void {
  if (!value.trim()) throw new Error(`invalid_streaming_preview_${field}`);
}

function sameSegments(
  left: JarvisStreamingPreview['segments'],
  right: JarvisStreamingPreview['segments'],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((before, index) => {
    const after = right[index];
    if (before.kind !== after.kind || before.id !== after.id) return false;
    if (before.kind === 'text' && after.kind === 'text') return before.text === after.text;
    return (
      before.kind === 'tool' &&
      after.kind === 'tool' &&
      before.name === after.name &&
      before.status === after.status &&
      before.fileLabel === after.fileLabel &&
      before.details === after.details
    );
  });
}

export function setPreview(preview: JarvisStreamingPreview): void {
  requireId(preview.accountId, 'account_id');
  requireId(preview.runId, 'run_id');
  requireId(preview.requestId, 'request_id');
  requireId(preview.chatId, 'chat_id');
  if (!Number.isFinite(preview.updatedAt)) throw new Error('invalid_streaming_preview_updated_at');
  const existing = previews.get(key(preview.accountId, preview.runId));
  if (
    existing?.requestId === preview.requestId &&
    existing.chatId === preview.chatId &&
    existing.text === preview.text &&
    existing.projectRoot === preview.projectRoot &&
    sameSegments(existing.segments, preview.segments)
  )
    return;
  // Public tool details are immutable boundary values. Compare their identity
  // instead of serializing every prior command/output on each text delta.
  const detached = Object.freeze({
    ...preview,
    publicationRevision: ++publicationRevision,
    publicationMonotonicMs: performance.now(),
    ...(preview.segments
      ? {
          segments: Object.freeze(preview.segments.map((segment) => Object.freeze({ ...segment }))),
        }
      : {}),
  });
  previews.set(key(detached.accountId, detached.runId), detached);
  const changedChats = new Set([key(detached.accountId, detached.chatId)]);
  if (existing) changedChats.add(key(existing.accountId, existing.chatId));
  notifyPreviews(changedChats);
}

export function getPreview(accountId: string, runId: string): JarvisStreamingPreview | null {
  return previews.get(key(accountId, runId)) ?? null;
}

export function clearPreview(accountId: string, runId: string): void {
  const entryKey = key(accountId, runId);
  const existing = previews.get(entryKey);
  if (existing && previews.delete(entryKey)) {
    notifyPreviews(new Set([key(existing.accountId, existing.chatId)]));
  }
}

export function clearAccountPreviews(accountId: string): void {
  const changedChats = new Set<string>();
  for (const [entryKey, preview] of previews) {
    if (preview.accountId === accountId) {
      previews.delete(entryKey);
      changedChats.add(key(preview.accountId, preview.chatId));
    }
  }
  notifyPreviews(changedChats);
}
