import type { Chat, Message } from '@/types';
import type { ChatActivityEvent } from '../activity/types';
import type { JarvisCommandCenterDataPort } from '@/features/jarvis-command-center/types';
import { buildChatDebugLog, type ChatDebugLog, type ChatDebugRun } from './chatDebugLog';

export interface ChatDebugLogSource {
  accountId: string;
  chatId: string;
  listMessages(): Promise<readonly Message[]>;
  getChat?(): Promise<Chat | undefined>;
  activity: readonly ChatActivityEvent[];
  dataPort?: Pick<
    JarvisCommandCenterDataPort,
    'getRunsForChat' | 'getEventsForRun' | 'getArtifactsForRun'
  >;
  isCurrent(): boolean;
  rendererUptimeMs?: number;
}

/** Read existing evidence only; never start a model, tool, recorder or journal writer. */
export async function loadChatDebugLog(source: ChatDebugLogSource): Promise<ChatDebugLog> {
  const readStartedAt = Date.now();
  const current = () => {
    if (!source.isCurrent()) throw new Error('Chat/account changed during export. Try again.');
  };
  current();
  const [messages, chat] = await Promise.all([source.listMessages(), source.getChat?.()]);
  current();
  const coverage: string[] = [];
  const runs: ChatDebugRun[] = [];
  const port = source.dataPort;
  if (!port)
    coverage.push(
      'Canonical journal connection unavailable; transcript and available activity only.',
    );
  else {
    try {
      const candidates = await port.getRunsForChat({
        accountId: source.accountId,
        chatId: source.chatId,
        limit: 50,
      });
      current();
      coverage.push(
        'Journal run lookup is limited to 50 chat runs within the latest 500 account runs. Older runs may be absent.',
      );
      let remaining = 10000;
      for (const run of candidates.slice(0, 50)) {
        if (run.accountId !== source.accountId || run.chatId !== source.chatId) continue;
        const events: ChatDebugRun['events'][number][] = [];
        const collected: ChatDebugRun = { run, events, artifacts: [] };
        runs.push(collected);
        let cursor = 0;
        let gapReported = false;
        while (remaining > 0) {
          const limit = Math.min(500, remaining);
          const page = await port.getEventsForRun({
            accountId: source.accountId,
            runId: run.id,
            afterSeq: cursor,
            limit,
          });
          current();
          const valid = page
            .filter(
              (event) =>
                event.runId === run.id && Number.isSafeInteger(event.seq) && event.seq > cursor,
            )
            .sort((a, b) => a.seq - b.seq);
          for (const event of valid.slice(0, limit)) {
            if (event.seq <= cursor) continue;
            if (event.seq !== cursor + 1 && !gapReported) {
              coverage.push(`Journal sequence gaps were observed for ${run.id}.`);
              gapReported = true;
            }
            events.push(event);
            cursor = event.seq;
            remaining -= 1;
          }
          if (page.length < limit) break;
          if (!valid.length) {
            coverage.push(`Journal pagination stopped without progress for ${run.id}.`);
            break;
          }
        }
        const artifacts = await port.getArtifactsForRun({
          accountId: source.accountId,
          runId: run.id,
          limit: 500,
        });
        current();
        if (artifacts.length >= 500)
          coverage.push(`Artifact coverage may be truncated for ${run.id} (500-record limit).`);
        collected.artifacts = artifacts.filter((artifact) => artifact.runId === run.id);
      }
      if (remaining === 0)
        coverage.push(
          'Journal event coverage reached the 10000-event export limit; later events are omitted.',
        );
    } catch {
      current();
      coverage.push('Some canonical journal records could not be read. This export is partial.');
    }
  }
  current();
  const exportedAt = Date.now();
  return buildChatDebugLog({
    chatId: source.chatId,
    chat:
      chat?.id === source.chatId
        ? {
            title: chat.title,
            backend_affinity: chat.backend_affinity,
            created_at: chat.created_at,
            updated_at: chat.updated_at,
          }
        : undefined,
    messages,
    activity: source.activity,
    runs,
    coverage,
    exportedAt,
    rendererUptimeMs:
      source.rendererUptimeMs === undefined
        ? undefined
        : source.rendererUptimeMs + exportedAt - readStartedAt,
  });
}
