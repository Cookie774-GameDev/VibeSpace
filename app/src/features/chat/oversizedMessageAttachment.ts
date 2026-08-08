import { isTauri } from '@/lib/utils';

export const OVERSIZED_CHAT_TEXT_THRESHOLD = 32_000;
export const OVERSIZED_CHAT_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface OversizedMessageAttachment {
  path: string;
  name: string;
  expiresAt: number;
}

type NativeBridge = {
  create: (content: string) => Promise<OversizedMessageAttachment>;
  cleanup: () => Promise<number>;
};

const nativeBridge: NativeBridge = {
  async create(content) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<OversizedMessageAttachment>('chat_temp_attachment_create', { content });
  },
  async cleanup() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<number>('chat_temp_attachment_cleanup');
  },
};

let cleanupStarted = false;

export function oversizedMessageSummary(attachment: OversizedMessageAttachment): string {
  return `[Long message attached: ${attachment.name}]\nTemporary file expires after 24 hours.`;
}

export async function createOversizedMessageAttachment(
  text: string,
  bridge: NativeBridge = nativeBridge,
  nativeRuntime = isTauri,
): Promise<OversizedMessageAttachment | null> {
  if (!nativeRuntime || text.length <= OVERSIZED_CHAT_TEXT_THRESHOLD) return null;
  return bridge.create(text);
}

/**
 * Always materialize text into a managed local temp file on desktop (any size).
 * Used for pathless browser File paste/drop of text-like general files.
 */
export async function createChatTextFileAttachment(
  text: string,
  bridge: NativeBridge = nativeBridge,
  nativeRuntime = isTauri,
): Promise<OversizedMessageAttachment | null> {
  if (!nativeRuntime || !text.trim()) return null;
  return bridge.create(text);
}

export function cleanupExpiredOversizedMessageAttachments(
  bridge: NativeBridge = nativeBridge,
  nativeRuntime = isTauri,
): void {
  if (!nativeRuntime || cleanupStarted) return;
  cleanupStarted = true;
  void bridge.cleanup().catch(() => {
    // Cleanup is best-effort. A later app session or attachment creation retries it.
    cleanupStarted = false;
  });
}

export function resetOversizedAttachmentCleanupForTests(): void {
  cleanupStarted = false;
}
