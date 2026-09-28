import { appDataDir } from '@tauri-apps/api/path';
import { messageRepo } from '@/lib/db';
import { createDirectory, readTextFile, writeTextFile } from '@/lib/fs';
import { isTauri } from '@/lib/utils';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import type { ChatId } from '@/types';
import {
  listVoiceNativeTasks,
  type VoiceNativeTaskRecord,
  type VoiceNativeTaskScope,
  type VoiceNativeTaskStatus,
  type VoiceNativeProvider,
} from './voiceNativeTaskIndex';

export type VoiceConversationFolderResult =
  { ok: true; folder: string; messageCount: number } | { ok: false; error: string };

const pendingWrites = new Map<string, Promise<VoiceConversationFolderResult>>();
const MAX_CHUNK_CHARS = 300_000;
const MAX_NATIVE_TASK_REFERENCES = 12;
const NATIVE_TASK_STATUSES = new Set<VoiceNativeTaskStatus>([
  'submitted',
  'launched',
  'running',
  'done',
  'blocked',
  'failed',
  'cancelled',
]);

export interface VoiceConversationNativeTaskReference {
  requestId: string;
  parentChatId: string;
  requestedMainProvider: VoiceNativeProvider;
  requestedWorkerProvider: VoiceNativeProvider;
  actualWorkerProvider?: VoiceNativeProvider;
  actualModelId?: string;
  nativeTaskId?: string;
  status: VoiceNativeTaskStatus;
  updatedAt: string;
  summary: string;
}

function toNativeTaskReferences(
  records: readonly VoiceNativeTaskRecord[],
  chatId: string,
): VoiceConversationNativeTaskReference[] {
  return records
    .filter((record) => record.parentChatId === chatId)
    .slice(0, MAX_NATIVE_TASK_REFERENCES)
    .map((record) => ({
      requestId: record.requestId,
      parentChatId: record.parentChatId,
      requestedMainProvider: record.requestedMainProvider,
      requestedWorkerProvider: record.requestedWorkerProvider,
      ...(record.actualWorker
        ? {
            actualWorkerProvider: record.actualWorker.provider,
            ...(record.actualWorker.modelId ? { actualModelId: record.actualWorker.modelId } : {}),
            nativeTaskId: record.actualWorker.nativeTaskId,
          }
        : {}),
      status: record.status,
      updatedAt: record.updatedAt,
      summary: record.summary.slice(0, 180),
    }));
}

function isNativeTaskReference(value: unknown): value is VoiceConversationNativeTaskReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/u.test(record.requestId) &&
    typeof record.parentChatId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/u.test(record.parentChatId) &&
    (record.requestedMainProvider === 'codex' || record.requestedMainProvider === 'opencode') &&
    (record.requestedWorkerProvider === 'codex' || record.requestedWorkerProvider === 'opencode') &&
    (record.actualWorkerProvider === undefined ||
      record.actualWorkerProvider === 'codex' ||
      record.actualWorkerProvider === 'opencode') &&
    (record.actualModelId === undefined ||
      (typeof record.actualModelId === 'string' && record.actualModelId.length <= 180)) &&
    (record.nativeTaskId === undefined ||
      (typeof record.nativeTaskId === 'string' && record.nativeTaskId.length <= 180)) &&
    typeof record.status === 'string' &&
    NATIVE_TASK_STATUSES.has(record.status as VoiceNativeTaskStatus) &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    typeof record.summary === 'string' &&
    record.summary.length <= 180
  );
}

function safeNativeReferenceSummary(summary: string): string {
  return summary
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{16,}\b/giu, '[redacted]')
    .replace(/\bgithub_pat_[a-z0-9_]{20,}\b/giu, '[redacted]')
    .replace(/\bgh[pousr]_[a-z0-9_]{20,}\b/giu, '[redacted]')
    .replace(/\b(bearer|token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);
}

async function previousNativeTaskReferences(
  indexPath: string,
  root: string,
  chatId: string,
): Promise<VoiceConversationNativeTaskReference[]> {
  const read = await readTextFile(indexPath, { root });
  if (!read.ok || read.content.length > 128_000) return [];
  try {
    const parsed: unknown = JSON.parse(read.content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const references = (parsed as { nativeTasks?: unknown }).nativeTasks;
    if (!Array.isArray(references)) return [];
    return references
      .filter(isNativeTaskReference)
      .filter((reference) => reference.parentChatId === chatId)
      .map((reference) => ({
        ...reference,
        summary: safeNativeReferenceSummary(reference.summary),
      }))
      .slice(0, MAX_NATIVE_TASK_REFERENCES);
  } catch {
    return [];
  }
}

async function writeConversationSnapshot(
  chatId: string,
  scope?: VoiceNativeTaskScope,
): Promise<VoiceConversationFolderResult> {
  if (!isTauri)
    return { ok: false, error: 'Voice conversation folders require VibeSpace desktop.' };
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(chatId)) {
    return { ok: false, error: 'The voice chat ID is invalid.' };
  }
  try {
    const root = (await appDataDir()).replace(/[\\/]+$/u, '');
    const base = `${root}/jarvis-voice-conversations`;
    const folder = `${base}/${chatId}`;
    for (const path of [base, folder]) {
      const created = await createDirectory(path, { root });
      if (!created.ok) return { ok: false, error: 'Could not create the voice chat folder.' };
    }

    const messages = await messageRepo.listByChat(chatId as ChatId);
    const lines = messages.map((message) =>
      JSON.stringify({
        id: String(message.id),
        role: message.role,
        createdAt: message.created_at,
        text: message.parts
          .filter((part) => part.kind === 'text')
          .map((part) => part.text)
          .join('\n'),
      }),
    );
    const chunks: string[] = [];
    let chunk = '';
    for (const line of lines) {
      if (chunk && chunk.length + line.length + 1 > MAX_CHUNK_CHARS) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += `${line}\n`;
    }
    chunks.push(chunk);
    for (const [index, content] of chunks.entries()) {
      const result = await writeTextFile(
        `${folder}/chat-${String(index + 1).padStart(4, '0')}.jsonl`,
        content,
        { root },
      );
      if (!result.ok) return { ok: false, error: 'Could not save the voice chat log.' };
    }
    const workers = useJarvisInteractionStore
      .getState()
      .agentsForChat(chatId)
      .map((agent) => ({
        agentId: String(agent.agentId),
        childChatId: String(agent.childChatId),
        modelLabel: agent.modelLabel,
        status: agent.status,
        updatedAt: agent.updatedAt,
        summary: agent.summary ?? '',
      }));
    const indexPath = `${folder}/index.json`;
    let nativeTasks = await previousNativeTaskReferences(indexPath, root, chatId);
    if (scope) {
      const listed = await listVoiceNativeTasks(scope);
      if (listed.ok) nativeTasks = toNativeTaskReferences(listed.records, chatId);
    }
    const index = await writeTextFile(
      indexPath,
      JSON.stringify(
        {
          version: 1,
          chatId,
          messageCount: messages.length,
          chunks: chunks.length,
          workers,
          nativeTasks,
        },
        null,
        2,
      ),
      { root },
    );
    if (!index.ok) return { ok: false, error: 'Could not save the voice chat index.' };
    return { ok: true, folder, messageCount: messages.length };
  } catch {
    return { ok: false, error: 'Could not save the voice chat folder.' };
  }
}

/** Serializes refreshes so an older snapshot cannot overwrite a newer one. */
export function syncVoiceConversationFolder(
  chatId: string,
  scope?: VoiceNativeTaskScope,
): Promise<VoiceConversationFolderResult> {
  const previous = pendingWrites.get(chatId) ?? Promise.resolve({ ok: false } as const);
  const next = previous.then(() => writeConversationSnapshot(chatId, scope));
  pendingWrites.set(chatId, next);
  void next.then(
    () => {
      if (pendingWrites.get(chatId) === next) pendingWrites.delete(chatId);
    },
    () => {
      if (pendingWrites.get(chatId) === next) pendingWrites.delete(chatId);
    },
  );
  return next;
}
