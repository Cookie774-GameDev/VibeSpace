import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import {
  createVoiceTaskCoordinator,
  formatPreviousVoiceTaskContext,
  listPreviousVoiceTasks,
  recordVoiceConversation,
} from './voiceTaskCoordinator';
import type {
  VoiceAgentFlowResult,
  VoiceAgentRequest,
  VoiceAgentFlowStatus,
} from './voiceAgentFlow';

const scope = { accountId: 'account-a', workspaceId: 'workspace-a', projectId: null };
const selection = { mode: 'single', providerId: 'openai', modelId: 'gpt-6' } as ChatModelSelection;

beforeEach(() => localStorage.clear());

function acceptedResult(requestId: string): VoiceAgentFlowResult {
  return {
    status: 'main_accepted',
    duplicate: false,
    requestId,
    cancellationKey: `message-${requestId}`,
    elapsedMs: 4,
  };
}

describe('voice Main request coordination', () => {
  it('deduplicates final STT repeats across modal reopens without creating a worker launch receipt', async () => {
    const coordinator = createVoiceTaskCoordinator();
    const request: VoiceAgentRequest & { requestId: string; dedupeScope: string } = {
      chatId: 'voice-chat-1',
      text: 'Fix the app',
      mainProvider: 'codex',
      workerProvider: 'opencode',
      selection,
      requestId: 'voice-req-1',
      dedupeScope: 'account-a/workspace-a',
    };
    const run = vi.fn(async (report: (status: VoiceAgentFlowStatus) => void) => {
      report({
        phase: 'main_accepted',
        chatId: request.chatId,
        mainProvider: request.mainProvider,
        workerProvider: request.workerProvider,
        requestId: request.requestId,
        elapsedMs: 2,
      });
      return acceptedResult(request.requestId);
    });

    const first = await coordinator.start(request, run);
    const repeated = await coordinator.start(
      { ...request, chatId: 'voice-chat-2', text: ' Fix   the app! ', requestId: 'new-id' },
      run,
    );

    expect(first).toMatchObject({ status: 'accepted', duplicate: false });
    expect(repeated).toMatchObject({ status: 'accepted', duplicate: true });
    expect(repeated).not.toHaveProperty('actualWorkerProvider');
    expect(repeated).not.toHaveProperty('childChatId');
    expect(run).toHaveBeenCalledOnce();
  });

  it('shares the in-flight promise and accepts only after Main runtime acceptance', async () => {
    const coordinator = createVoiceTaskCoordinator();
    const request: VoiceAgentRequest & { requestId: string } = {
      chatId: 'voice-chat',
      text: 'Review the patch',
      mainProvider: 'codex',
      workerProvider: 'codex',
      selection,
      requestId: 'voice-req-2',
    };
    let finish!: (result: VoiceAgentFlowResult) => void;
    const run = vi.fn((report: (status: VoiceAgentFlowStatus) => void) => {
      report({
        phase: 'submitted',
        chatId: request.chatId,
        mainProvider: request.mainProvider,
        workerProvider: request.workerProvider,
        requestId: request.requestId,
        elapsedMs: 1,
      });
      return new Promise<VoiceAgentFlowResult>((resolve) => {
        finish = resolve;
      });
    });
    const first = coordinator.start(request, run);
    const duplicate = coordinator.start({ ...request, requestId: 'duplicate-id' }, run);

    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish(acceptedResult(request.requestId));

    await expect(first).resolves.toMatchObject({ status: 'accepted', duplicate: false });
    await expect(duplicate).resolves.toMatchObject({ status: 'accepted', duplicate: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    ['persist_failed', 'persist_failed'],
    ['dispatch_failed', 'dispatch_failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'returns %s truthfully and does not convert it to accepted',
    async (status, expected) => {
      const coordinator = createVoiceTaskCoordinator();
      const request: VoiceAgentRequest & { requestId: string } = {
        chatId: 'voice-chat',
        text: `Fail ${status}`,
        mainProvider: 'codex',
        workerProvider: 'opencode',
        selection,
        requestId: `request-${status}`,
      };
      const result: VoiceAgentFlowResult = {
        status,
        duplicate: false,
        requestId: request.requestId,
        elapsedMs: 1,
      };

      await expect(coordinator.start(request, async () => result)).resolves.toMatchObject({
        status: expected,
        duplicate: false,
      });
    },
  );

  it('keeps a failed request deduplicated for a repeated transcript', async () => {
    const coordinator = createVoiceTaskCoordinator();
    const request: VoiceAgentRequest & { requestId: string } = {
      chatId: 'voice-chat',
      text: 'Check the tests',
      mainProvider: 'codex',
      workerProvider: 'opencode',
      selection,
      requestId: 'request-failed',
    };
    const run = vi.fn(async () => ({
      status: 'dispatch_failed' as const,
      duplicate: false as const,
      requestId: request.requestId,
      elapsedMs: 1,
    }));

    await expect(coordinator.start(request, run)).resolves.toMatchObject({
      status: 'dispatch_failed',
    });
    await expect(
      coordinator.start({ ...request, text: ' Check   the tests. ', requestId: 'retry-id' }, run),
    ).resolves.toMatchObject({ status: 'dispatch_failed', duplicate: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps legacy history bounded without inventing a child for new native task records', () => {
    recordVoiceConversation(scope, 'voice-chat-1');
    recordVoiceConversation(scope, 'voice-chat-2');
    recordVoiceConversation({ ...scope, accountId: 'account-b' }, 'other-account-chat');
    const card = (parentChatId: string, agentId: string): JarvisChatAgent =>
      ({
        parentChatId,
        agentId,
        childChatId: `legacy-child-${agentId}`,
        modelLabel: 'OpenCode · GPT',
        status: 'thinking',
        task: 'An old task',
        summary: '',
        updatedAt: '2026-09-27T19:00:00Z',
      }) as JarvisChatAgent;
    const tasks = listPreviousVoiceTasks(scope, 'voice-chat-2', {
      'voice-chat-1': [card('voice-chat-1', 'worker-1')],
      'voice-chat-2': [card('voice-chat-2', 'worker-2')],
      'other-account-chat': [card('other-account-chat', 'worker-3')],
    });

    expect(tasks.map((task) => task.agentId)).toEqual(['worker-1']);
    expect(formatPreviousVoiceTaskContext(tasks)).toContain('legacy-child-worker-1');
    expect(formatPreviousVoiceTaskContext(tasks)).not.toContain('worker-2');
    expect(formatPreviousVoiceTaskContext(tasks).length).toBeLessThanOrEqual(1_500);
  });
});
