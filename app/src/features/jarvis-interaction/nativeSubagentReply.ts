import { chatRepo, messageRepo } from '@/lib/db/repositories';
import type { ChatId } from '@/types/common';
import type { NativeTaskActivity } from '@/lib/ai/openCodeNativeActivity';
import type { JarvisChatAgent } from './types';

type ReplyDependencies = {
  repos?: {
    chatRepo: Pick<typeof chatRepo, 'getById'>;
    messageRepo: Pick<typeof messageRepo, 'create'>;
  };
  dispatchEvent?: (event: CustomEvent) => void;
};
const nativeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,512}$/.test(value);
function replyText(value: string): string {
  const text = value.trim();
  if (!text || text.length > 32_768) throw new Error('Enter a reply of at most 32,768 characters.');
  return text;
}

/** Native agent tools are model tools, not invented client RPCs. Ask the owning
 * parent to use its supported child control; only native events acknowledge it. */
export async function requestNativeSubagentReply(
  input: ReplyDependencies & {
    parentChatId: string;
    run: Pick<NativeTaskActivity, 'name' | 'sessionId' | 'parentSessionId' | 'harness'>;
    text: string;
  },
): Promise<void> {
  const text = replyText(input.text);
  const { sessionId, parentSessionId, harness } = input.run;
  if (
    !nativeId(sessionId) ||
    !['codex', 'opencode'].includes(harness ?? '') ||
    (parentSessionId !== undefined && (!nativeId(parentSessionId) || parentSessionId === sessionId))
  ) {
    throw new Error('Native reply unavailable: session route not reported.');
  }
  const repos = input.repos ?? { chatRepo, messageRepo };
  const parent = await repos.chatRepo.getById(input.parentChatId as ChatId);
  if (!parent) throw new Error('Parent chat no longer exists.');
  // Legacy chats use OpenCode. Never send a recorded Codex child to that route.
  if ((parent.backend_affinity?.backend ?? 'opencode') !== harness) {
    throw new Error('Native child backend does not match this parent chat.');
  }
  const instruction =
    harness === 'opencode'
      ? 'Send this reply with your native task tool using task_id exactly equal to nativeSessionId. Continue that existing child session; do not spawn a replacement.'
      : 'Send this reply to nativeSessionId with the supported native sendInput or followupTask/sendMessage agent control. If needed, resumeAgent for that same ID. Do not spawn a replacement.';
  const visibleText = `Reply to ${input.run.name}: ${text}`;
  await repos.messageRepo.create({
    chat_id: input.parentChatId as ChatId,
    role: 'user',
    parts: [{ kind: 'text', text: visibleText }],
  });
  (input.dispatchEvent ?? ((event) => window.dispatchEvent(event)))(
    new CustomEvent('jarvis:send', {
      detail: {
        chatId: input.parentChatId,
        text: visibleText,
        interactionMode: 'agent',
        queueIfBusy: true,
        structuredContext: {
          kind: 'subagents',
          payload: {
            delegation: 'provider-native',
            operation: 'reply',
            nativeSessionId: sessionId,
            ...(parentSessionId ? { nativeParentSessionId: parentSessionId } : {}),
            reply: text,
            instruction: `${instruction} Keep the child's native model/effort and permissions. Report an unavailable control or missing child honestly; only claim delivery after its native acknowledgment.`,
          },
        },
      },
    }),
  );
}

/** Preserve existing compatibility/voice child chats and their adapter binding. */
export async function requestBoundChildReply(
  input: ReplyDependencies & {
    agent: JarvisChatAgent;
    text: string;
  },
): Promise<void> {
  const text = replyText(input.text);
  const agent = input.agent;
  if (!nativeId(agent.harnessSessionId))
    throw new Error('Native reply unavailable: child session not bound.');
  const repos = input.repos ?? { chatRepo, messageRepo };
  const [parent, child] = await Promise.all([
    repos.chatRepo.getById(agent.parentChatId as ChatId),
    repos.chatRepo.getById(agent.childChatId as ChatId),
  ]);
  if (
    !parent ||
    !child ||
    parent.workspace_id !== child.workspace_id ||
    parent.project_id !== child.project_id ||
    String(agent.parentChatId) === String(agent.childChatId)
  )
    throw new Error('Child chat scope no longer matches its parent.');
  await repos.messageRepo.create({
    chat_id: agent.childChatId as ChatId,
    role: 'user',
    parts: [{ kind: 'text', text }],
  });
  (input.dispatchEvent ?? ((event) => window.dispatchEvent(event)))(
    new CustomEvent('jarvis:send', {
      detail: {
        chatId: agent.childChatId,
        text,
        interactionMode: 'agent',
        queueIfBusy: true,
        ...(agent.modelSelection ? { modelSelectionOverride: agent.modelSelection } : {}),
        structuredContext: {
          kind: 'subagents',
          payload: { parentChatId: agent.parentChatId, agentId: agent.agentId, task: text },
        },
      },
    }),
  );
}
