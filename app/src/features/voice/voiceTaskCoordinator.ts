import type {
  VoiceAgentFlowResult,
  VoiceAgentFlowStatus,
  VoiceAgentRequest,
} from './voiceAgentFlow';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';

const RECENT_DUPLICATE_MS = 45_000;
const VOICE_CHAT_INDEX_KEY = 'jarvis-voice-conversation-index-v1';
const MAX_VOICE_CHATS = 60;
const MAX_VISIBLE_TASKS = 8;

export interface VoiceConversationScope {
  accountId: string;
  workspaceId: string;
  projectId: string | null;
}

export interface PreviousVoiceTask {
  agentId: string;
  parentChatId: string;
  childChatId: string;
  provider: 'Codex' | 'OpenCode' | 'Unknown';
  status: JarvisChatAgent['status'];
  task: string;
  summary: string;
  updatedAt: string;
}

function scopeKey(scope: VoiceConversationScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId]);
}

function readIndex(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_CHAT_INDEX_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** Index only chat IDs. The chat database and persisted agent cards own the history. */
export function recordVoiceConversation(scope: VoiceConversationScope, chatId: string): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(chatId)) return false;
  try {
    const all = readIndex();
    const key = scopeKey(scope);
    all[key] = [...(all[key] ?? []).filter((id) => id !== chatId), chatId].slice(-MAX_VOICE_CHATS);
    localStorage.setItem(VOICE_CHAT_INDEX_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function isVoiceConversationInScope(scope: VoiceConversationScope, chatId: string): boolean {
  return (readIndex()[scopeKey(scope)] ?? []).includes(chatId);
}

export function listPreviousVoiceTasks(
  scope: VoiceConversationScope,
  currentChatId: string,
  agentsByChat: Readonly<Record<string, readonly JarvisChatAgent[]>>,
): PreviousVoiceTask[] {
  return (readIndex()[scopeKey(scope)] ?? [])
    .filter((id) => id !== currentChatId)
    .flatMap((parentChatId) =>
      (agentsByChat[parentChatId] ?? [])
        .filter((agent) => String(agent.parentChatId) === parentChatId)
        .map((agent) => ({
          agentId: String(agent.agentId),
          parentChatId,
          childChatId: String(agent.childChatId),
          provider: agent.modelLabel.startsWith('Codex')
            ? ('Codex' as const)
            : agent.modelLabel.startsWith('OpenCode')
              ? ('OpenCode' as const)
              : ('Unknown' as const),
          status: agent.status,
          task: agent.task.slice(0, 120),
          summary: (agent.summary ?? agent.error ?? '').slice(0, 180),
          updatedAt: agent.updatedAt,
        })),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_VISIBLE_TASKS);
}

export function formatPreviousVoiceTaskContext(tasks: readonly PreviousVoiceTask[]): string {
  if (!tasks.length) return '';
  return [
    'Prior Jarvis voice workers (status only; keep their existing child chats; do not restart them):',
    ...tasks.map(
      (task) =>
        `${task.provider} ${task.agentId} [${task.status}] child ${task.childChatId}: ${task.task}${task.summary ? ` — ${task.summary}` : ''}`,
    ),
  ]
    .join('\n')
    .slice(0, 1_500);
}

export interface VoiceTaskCoordinatorReceipt {
  status: 'accepted' | 'persist_failed' | 'dispatch_failed' | 'cancelled';
  duplicate: boolean;
  requestId: string;
  cancellationKey?: string;
}

/** Owns Main-send deduplication across short-lived voice modal instances. */
export function createVoiceTaskCoordinator(now: () => number = Date.now) {
  const operations = new Map<
    string,
    { completedAt?: number; result: Promise<VoiceTaskCoordinatorReceipt> }
  >();
  const start = (
    request: VoiceAgentRequest & { dedupeScope?: string },
    run: (report: (status: VoiceAgentFlowStatus) => void) => Promise<VoiceAgentFlowResult>,
  ): Promise<VoiceTaskCoordinatorReceipt> => {
    const startedAt = now();
    for (const [key, entry] of operations) {
      if (entry.completedAt !== undefined && startedAt - entry.completedAt >= RECENT_DUPLICATE_MS)
        operations.delete(key);
    }
    const key = JSON.stringify([
      request.dedupeScope ?? request.chatId,
      request.mainProvider,
      request.workerProvider,
      request.text
        .trim()
        .replace(/\s+/gu, ' ')
        .replace(/[.!?]+$/gu, '')
        .toLowerCase(),
    ]);
    const prior = operations.get(key);
    if (prior) return prior.result.then((receipt) => ({ ...receipt, duplicate: true }));

    const report = (_status: VoiceAgentFlowStatus) => undefined;
    const entry: { completedAt?: number; result: Promise<VoiceTaskCoordinatorReceipt> } = {
      result: Promise.resolve({
        status: 'dispatch_failed',
        duplicate: false,
        requestId: request.requestId ?? '',
      }),
    };
    operations.set(key, entry);
    const result = Promise.resolve()
      .then(() => run(report))
      .then(
        (flowResult): VoiceTaskCoordinatorReceipt => ({
          status: flowResult.status === 'main_accepted' ? 'accepted' : flowResult.status,
          duplicate: false,
          requestId: flowResult.requestId,
          ...(flowResult.cancellationKey ? { cancellationKey: flowResult.cancellationKey } : {}),
        }),
        (): VoiceTaskCoordinatorReceipt => ({
          status: 'dispatch_failed',
          duplicate: false,
          requestId: request.requestId ?? '',
        }),
      );
    entry.result = result;
    void result.then(() => {
      entry.completedAt = now();
    });
    return result;
  };
  return { start };
}

export const voiceTaskCoordinator = createVoiceTaskCoordinator();
