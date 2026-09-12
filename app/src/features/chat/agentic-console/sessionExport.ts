/**
 * Lightweight per-chat session log builder for Export session.
 * Source of truth remains Dexie messages already loaded for this chat.
 */

export interface ChatSessionExportMessage {
  id: string;
  role: string;
  created_at: string | number;
  updated_at?: string | number;
  agent_id?: string | null;
  usage?: unknown;
  parts: unknown[];
}

export interface ChatSessionExportInput {
  chatId: string;
  messages: ReadonlyArray<{
    id: string;
    role: string;
    created_at: string | number;
    updated_at?: string | number;
    agent_id?: string | null;
    usage?: unknown;
    parts: unknown[];
  }>;
  summary: unknown;
  blocks: unknown[];
  exportedAt?: string;
}

export interface ChatSessionExportPayload {
  version: 2;
  chatId: string;
  exportedAt: string;
  summary: unknown;
  /** Full transcript log for this chat only (lightweight JSON). */
  messages: ChatSessionExportMessage[];
  /** Agentic projection blocks for UI fidelity. */
  blocks: unknown[];
}

export function buildChatSessionExport(input: ChatSessionExportInput): ChatSessionExportPayload {
  const messages: ChatSessionExportMessage[] = input.messages.map((message) => ({
    id: String(message.id),
    role: String(message.role),
    created_at: message.created_at,
    updated_at: message.updated_at,
    agent_id: message.agent_id ?? null,
    usage: message.usage,
    parts: Array.isArray(message.parts) ? message.parts : [],
  }));

  return {
    version: 2,
    chatId: String(input.chatId),
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    summary: input.summary,
    messages,
    blocks: input.blocks,
  };
}

export function sessionExportFilename(chatId: string): string {
  const safe = String(chatId).replace(/[^a-z0-9_-]/gi, '_');
  return `vibespace-session-${safe}.json`;
}

export function downloadChatSessionExport(payload: ChatSessionExportPayload): void {
  const body = JSON.stringify(payload, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sessionExportFilename(payload.chatId);
  anchor.click();
  URL.revokeObjectURL(url);
}
