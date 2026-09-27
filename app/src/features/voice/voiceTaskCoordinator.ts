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

export interface VoiceTaskLaunchReceipt {
  status: 'submitted' | 'launched' | 'launch_failed' | 'cancelled';
  duplicate: boolean;
  actualWorkerProvider?: 'codex' | 'opencode';
  childChatId?: string;
}

/** Long-running worker completion belongs here, outside the short-lived voice modal. */
export function createVoiceTaskCoordinator(now: () => number = Date.now) {
  const operations = new Map<
    string,
    { startedAt: number; completedAt?: number; launch: Promise<VoiceTaskLaunchReceipt> }
  >();
  const start = (
    request: VoiceAgentRequest & { dedupeScope?: string },
    run: (report: (status: VoiceAgentFlowStatus) => void) => Promise<VoiceAgentFlowResult>,
  ): Promise<VoiceTaskLaunchReceipt> => {
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
    if (prior) return prior.launch.then((receipt) => ({ ...receipt, duplicate: true }));

    let resolveLaunch!: (receipt: VoiceTaskLaunchReceipt) => void;
    const launch = new Promise<VoiceTaskLaunchReceipt>((resolve) => {
      resolveLaunch = resolve;
    });
    let launched = false;
    const report = (status: VoiceAgentFlowStatus) => {
      if (status.phase === 'submitted') {
        resolveLaunch({ status: 'submitted', duplicate: false });
      } else if (status.phase === 'launched') {
        launched = true;
        resolveLaunch({
          status: 'launched',
          duplicate: false,
          actualWorkerProvider: status.provider,
        });
      } else if (status.phase === 'launch_failed' || status.phase === 'cancelled') {
        resolveLaunch({ status: status.phase, duplicate: false });
      }
    };
    const entry: {
      startedAt: number;
      completedAt?: number;
      launch: Promise<VoiceTaskLaunchReceipt>;
    } = {
      startedAt,
      launch,
    };
    operations.set(key, entry);
    void Promise.resolve()
      .then(() => run(report))
      .then(
        (result) => {
          if (!launched) {
            resolveLaunch({
              status: result.status === 'cancelled' ? 'cancelled' : 'launch_failed',
              duplicate: false,
            });
            operations.delete(key);
            return;
          }
          entry.completedAt = now();
        },
        () => {
          if (!launched) resolveLaunch({ status: 'launch_failed', duplicate: false });
          if (!launched) operations.delete(key);
          entry.completedAt = now();
        },
      );
    return launch;
  };
  return { start };
}

export const voiceTaskCoordinator = createVoiceTaskCoordinator();
