import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisChatAgent } from '@/features/jarvis-interaction/types';
import {
  createVoiceTaskCoordinator,
  formatPreviousVoiceTaskContext,
  listPreviousVoiceTasks,
  recordVoiceConversation,
} from './voiceTaskCoordinator';

const scope = { accountId: 'account-a', workspaceId: 'workspace-a', projectId: null };

beforeEach(() => localStorage.clear());

describe('voice task continuity', () => {
  it('keeps an old worker running while a fresh voice chat starts and dedupes repeated transcripts', async () => {
    const coordinator = createVoiceTaskCoordinator();
    const oldRequest = {
      chatId: 'voice-chat-1',
      text: 'Fix the app',
      mainProvider: 'codex' as const,
      workerProvider: 'opencode' as const,
      dedupeScope: 'account-a/workspace-a',
    };
    let finishOld!: (result: {
      status: 'main_dispatched';
      duplicate: false;
      elapsedMs: number;
    }) => void;
    let reportOld!: (status: {
      phase: 'launched';
      chatId: string;
      provider: 'opencode';
      elapsedMs: number;
    }) => void;
    const runOld = vi.fn((report: typeof reportOld) => {
      reportOld = report;
      return new Promise<{
        status: 'main_dispatched';
        duplicate: false;
        elapsedMs: number;
      }>((resolve) => {
        finishOld = resolve;
      });
    });
    const first = coordinator.start(oldRequest, runOld);
    await Promise.resolve();
    reportOld({ phase: 'launched', chatId: oldRequest.chatId, provider: 'opencode', elapsedMs: 2 });
    await expect(first).resolves.toMatchObject({ status: 'launched', duplicate: false });
    await expect(
      coordinator.start({ ...oldRequest, text: 'Fix  the app!' }, runOld),
    ).resolves.toMatchObject({
      status: 'launched',
      duplicate: true,
    });
    expect(runOld).toHaveBeenCalledOnce();

    await expect(
      coordinator.start({ ...oldRequest, chatId: 'voice-chat-2' }, runOld),
    ).resolves.toMatchObject({ status: 'launched', duplicate: true });
    expect(runOld).toHaveBeenCalledOnce();

    const fresh = coordinator.start(
      { ...oldRequest, chatId: 'voice-chat-2', text: 'Another task' },
      (report) => {
        report({ phase: 'launched', chatId: 'voice-chat-2', provider: 'opencode', elapsedMs: 1 });
        return Promise.resolve({ status: 'main_dispatched', duplicate: false, elapsedMs: 1 });
      },
    );
    await expect(fresh).resolves.toMatchObject({ status: 'launched', duplicate: false });
    finishOld({ status: 'main_dispatched', duplicate: false, elapsedMs: 4 });
  });

  it('never reports a worker launched when its operation fails before receipt', async () => {
    const coordinator = createVoiceTaskCoordinator();
    await expect(
      coordinator.start(
        { chatId: 'voice-chat', text: 'Run task', mainProvider: 'codex', workerProvider: 'codex' },
        async () => ({ status: 'launch_failed', duplicate: false, elapsedMs: 1 }),
      ),
    ).resolves.toMatchObject({ status: 'launch_failed' });
  });

  it('releases the voice turn as submitted while provider proof and worker completion remain pending', async () => {
    const coordinator = createVoiceTaskCoordinator();
    let finish!: (result: {
      status: 'main_dispatched';
      duplicate: false;
      elapsedMs: number;
    }) => void;
    const receipt = await coordinator.start(
      { chatId: 'voice-chat', text: 'Long task', mainProvider: 'codex', workerProvider: 'codex' },
      (report) => {
        report({ phase: 'submitted', chatId: 'voice-chat', provider: 'codex', elapsedMs: 3 });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    expect(receipt).toEqual({ status: 'submitted', duplicate: false });
    finish({ status: 'main_dispatched', duplicate: false, elapsedMs: 100 });
  });

  it('loads only same-scope prior task references and a bounded context', () => {
    recordVoiceConversation(scope, 'voice-chat-1');
    recordVoiceConversation(scope, 'voice-chat-2');
    recordVoiceConversation({ ...scope, accountId: 'account-b' }, 'other-account-chat');
    const card = (parentChatId: string, agentId: string): JarvisChatAgent =>
      ({
        parentChatId,
        agentId,
        childChatId: `child-${agentId}`,
        modelLabel: 'OpenCode · GPT',
        status: 'thinking',
        task: 'Build a large task',
        summary: '',
        updatedAt: '2026-09-27T19:00:00Z',
      }) as JarvisChatAgent;
    const tasks = listPreviousVoiceTasks(scope, 'voice-chat-2', {
      'voice-chat-1': [card('voice-chat-1', 'worker-1')],
      'voice-chat-2': [card('voice-chat-2', 'worker-2')],
      'other-account-chat': [card('other-account-chat', 'worker-3')],
    });
    expect(tasks.map((task) => task.agentId)).toEqual(['worker-1']);
    expect(formatPreviousVoiceTaskContext(tasks)).toContain('child-worker-1');
    expect(formatPreviousVoiceTaskContext(tasks)).not.toContain('worker-2');
    expect(formatPreviousVoiceTaskContext(tasks).length).toBeLessThanOrEqual(1_500);
  });
});
