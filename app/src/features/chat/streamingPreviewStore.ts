export interface JarvisStreamingPreview {
  accountId: string;
  runId: string;
  requestId: string;
  chatId: string;
  text: string;
  updatedAt: number;
}

const listeners = new Set<() => void>();
export function subscribePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notifyPreviews(): void {
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

function key(accountId: string, runId: string): string {
  return `${accountId.length}:${accountId}${runId}`;
}

function requireId(value: string, field: string): void {
  if (!value.trim()) throw new Error(`invalid_streaming_preview_${field}`);
}

export function setPreview(preview: JarvisStreamingPreview): void {
  requireId(preview.accountId, 'account_id');
  requireId(preview.runId, 'run_id');
  requireId(preview.requestId, 'request_id');
  requireId(preview.chatId, 'chat_id');
  if (!Number.isFinite(preview.updatedAt)) throw new Error('invalid_streaming_preview_updated_at');
  const detached = Object.freeze({ ...preview });
  const existing = previews.get(key(detached.accountId, detached.runId));
  if (
    existing?.requestId === detached.requestId &&
    existing.chatId === detached.chatId &&
    existing.text === detached.text
  )
    return;
  previews.set(key(detached.accountId, detached.runId), detached);
  notifyPreviews();
}

export function getPreview(accountId: string, runId: string): JarvisStreamingPreview | null {
  return previews.get(key(accountId, runId)) ?? null;
}

export function clearPreview(accountId: string, runId: string): void {
  if (previews.delete(key(accountId, runId))) notifyPreviews();
}

export function clearAccountPreviews(accountId: string): void {
  for (const [entryKey, preview] of previews) {
    if (preview.accountId === accountId) previews.delete(entryKey);
  }
  notifyPreviews();
}
