import { appDataDir } from '@tauri-apps/api/path';
import { messageRepo } from '@/lib/db';
import { createDirectory, writeTextFile } from '@/lib/fs';
import { isTauri } from '@/lib/utils';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import type { ChatId } from '@/types';

export type VoiceConversationFolderResult =
  { ok: true; folder: string; messageCount: number } | { ok: false; error: string };

const pendingWrites = new Map<string, Promise<VoiceConversationFolderResult>>();
const MAX_CHUNK_CHARS = 300_000;

async function writeConversationSnapshot(chatId: string): Promise<VoiceConversationFolderResult> {
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
    const index = await writeTextFile(
      `${folder}/index.json`,
      JSON.stringify(
        { version: 1, chatId, messageCount: messages.length, chunks: chunks.length, workers },
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
): Promise<VoiceConversationFolderResult> {
  const previous = pendingWrites.get(chatId) ?? Promise.resolve({ ok: false } as const);
  const next = previous.then(() => writeConversationSnapshot(chatId));
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
