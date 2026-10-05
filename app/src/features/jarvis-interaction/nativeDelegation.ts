import { chatRepo, messageRepo } from '@/lib/db/repositories';
import type { ChatId } from '@/types/common';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';

/** Ask the existing parent session to delegate using its own native tools. */
export async function requestNativeDelegation(input: {
  parentChatId: ChatId | string;
  task: string;
  commandName: 'multitask' | 'subagents';
  modelSelection?: ChatModelSelection;
  repos?: {
    chatRepo: Pick<typeof chatRepo, 'getById'>;
    messageRepo: Pick<typeof messageRepo, 'create'>;
  };
  dispatchEvent?: (event: CustomEvent) => void;
}): Promise<void> {
  const task = input.task.trim();
  if (!task) throw new Error('A delegation task is required.');
  const repos = input.repos ?? { chatRepo, messageRepo };
  if (!(await repos.chatRepo.getById(input.parentChatId as ChatId)))
    throw new Error('Parent chat not found.');
  const text = `/${input.commandName} ${task}`;
  await repos.messageRepo.create({
    chat_id: input.parentChatId as ChatId,
    role: 'user',
    parts: [{ kind: 'text', text }],
  });
  (input.dispatchEvent ?? ((event) => window.dispatchEvent(event)))(
    new CustomEvent('jarvis:send', {
      detail: {
        chatId: input.parentChatId,
        text,
        interactionMode: 'agent',
        queueIfBusy: true,
        ...(input.modelSelection ? { modelSelectionOverride: input.modelSelection } : {}),
        structuredContext: {
          kind: input.commandName,
          payload: {
            task,
            delegation: 'provider-native',
            instruction:
              'Use your provider-native subagent tools for this task. Keep ownership in this parent session and preserve native configured model, reasoning effort and permissions; do not substitute unrelated VibeSpace worker defaults. For OpenCode use task and its returned task_id to resume or send follow-up work; for Codex use its available native agent tools. Preserve returned child IDs and report actual child model/status/results. If native delegation is unavailable, report that limitation. Collect their results and continue here. Do not create VibeSpace child chats or use agent.run/run_many.',
          },
        },
      },
    }),
  );
}
