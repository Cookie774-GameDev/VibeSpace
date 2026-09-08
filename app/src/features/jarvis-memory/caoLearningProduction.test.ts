import { beforeEach, expect, it, vi } from 'vitest';
import type { RunAgentRequest } from '@/lib/ai/router';
import { CAO_GUIDANCE_AREAS } from './caoGuidance';
import { useJarvisLearningStore } from './learningStore';
import { executeProductionCaoLearning, reviewCaoChatLearning } from './caoLearningProduction';
import type { CaoLearningExecutionInput } from './caoScheduledLearning';

const mocks = vi.hoisted(() => ({
  account: 'account',
  file: vi.fn(),
  put: vi.fn(),
  dispatch: vi.fn(),
  messages: [] as unknown[],
}));
vi.mock('@/lib/accountIdentity', () => ({
  getActiveAccountIdentity: () => ({ accountId: mocks.account }),
}));
vi.mock('@/lib/ai/router', () => ({
  runAgent: (request: RunAgentRequest) => mocks.dispatch(request),
}));
vi.mock('./learningFile', () => ({
  saveLearningFile: (...args: unknown[]) => mocks.file(...args),
}));
vi.mock('@/lib/db', () => ({
  db: {
    workspaces: { get: async () => ({ owner_id: 'account' }) },
    projects: { get: async () => ({ workspace_id: 'workspace' }) },
    chats: {
      get: async () => ({ id: 'new-chat', project_id: 'new-project', workspace_id: 'workspace' }),
      where: () => ({
        equals: () => ({
          filter: () => ({
            toArray: async () => [
              { id: 'opencode', updated_at: 2 },
              { id: 'codex', updated_at: 1 },
            ],
          }),
        }),
      }),
    },
    messages: {
      where: () => ({
        between: ([chatId]: string[]) => ({
          reverse: () => ({
            limit: () => ({
              toArray: async () => mocks.messages.filter((row: any) => row.chat_id === chatId),
            }),
          }),
        }),
      }),
    },
    settings: { get: async () => undefined, put: (...args: unknown[]) => mocks.put(...args) },
    transaction: async (_mode: unknown, _table: unknown, action: () => Promise<void>) => action(),
  },
}));
const input: CaoLearningExecutionInput = {
  accountId: 'account',
  workspaceId: 'workspace',
  projectId: 'project',
  scheduleId: 'schedule',
  targetId: 'cao',
  passId: 'pass',
  requestId: 'request',
  trigger: 'learning_threshold',
  fromSeqExclusive: 0,
  throughSeqInclusive: 20,
  requestedAt: 100,
};
beforeEach(() => {
  mocks.account = 'account';
  mocks.file.mockReset().mockResolvedValue({});
  mocks.put.mockReset().mockResolvedValue({});
  mocks.dispatch.mockReset();
  const store = useJarvisLearningStore.getState();
  store.clearForTests();
  store.setAccount('account');
  mocks.messages = ['opencode', 'codex'].flatMap((chatId) =>
    Array.from({ length: 10 }, (_, i) => {
      const text = `PLEASE handle only the requested files; verify results and report corrections for ${chatId} task ${i}.`;
      store.recordUserMessage({ text, chatId });
      return {
        id: `${chatId}-${i}`,
        chat_id: chatId,
        role: 'user',
        created_at: i,
        parts: [{ kind: 'text', text }],
      };
    }),
  );
  mocks.dispatch.mockImplementation(async (request: RunAgentRequest) => {
    request.onProviderCompletionEvidence?.({
      requestId: 'request',
      sessionId: 'session',
      providerId: 'openai',
      connectionId: 'openai-codex',
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      observedAt: 100,
      usage: { capturedAt: 100 },
    });
    return {
      text: JSON.stringify({
        sections: Object.fromEntries(
          CAO_GUIDANCE_AREAS.map((area) => [
            area,
            {
              guidance:
                'Preserve requested file scope, verify observed results, and explain corrections directly.',
              sourceIds: ['opencode-0', 'codex-0'],
            },
          ]),
        ),
      }),
    };
  });
});
it('feeds both ten-message chats to the pinned learner and writes source-backed CAO guidance into learning.md', async () => {
  expect((await executeProductionCaoLearning(input, new AbortController().signal)).status).toBe(
    'completed',
  );
  const request = mocks.dispatch.mock.calls[0]![0] as RunAgentRequest;
  expect(request.messages[0]?.content).toContain('opencode-9');
  expect(request.messages[0]?.content).toContain('codex-9');
  expect(request).toMatchObject({
    backend: 'codex',
    connectionId: 'openai-codex',
    accessLevel: 'read-only',
  });
  expect(mocks.file.mock.calls[0]?.[1]).toContain('## CAO — How to handle my chats and agents');
  expect(mocks.file.mock.calls[0]?.[1]).toContain('Sources: opencode-0, codex-0');
  expect(
    useJarvisLearningStore.getState().currentProfile().caoGuidance?.sections.fileHandling,
  ).toBeDefined();
});
it('does not consume learning or activate guidance when the physical file cannot be saved', async () => {
  mocks.file.mockRejectedValue(new Error('disk unavailable'));
  expect((await executeProductionCaoLearning(input, new AbortController().signal)).status).toBe(
    'failed',
  );
  expect(useJarvisLearningStore.getState().currentProfile().lastEvaluationCount).toBe(0);
  expect(useJarvisLearningStore.getState().currentProfile().caoGuidance).toBeUndefined();
  expect(mocks.put).not.toHaveBeenCalled();
});
it('rejects an account switch during model extraction', async () => {
  mocks.dispatch.mockImplementation(async () => {
    mocks.account = 'foreign';
    return { text: '{}' };
  });
  expect((await executeProductionCaoLearning(input, new AbortController().signal)).status).toBe(
    'failed',
  );
  expect(mocks.file).not.toHaveBeenCalled();
});

it('retains established source-backed areas omitted by a later partial project review', async () => {
 await executeProductionCaoLearning(input,new AbortController().signal);
 const prior=useJarvisLearningStore.getState().currentProfile().caoGuidance!.sections.corrections;
 const dispatch=mocks.dispatch.getMockImplementation()!;
 mocks.dispatch.mockImplementation(async request=>{const result=await dispatch(request);const value=JSON.parse(result.text);delete value.sections.corrections;return {text:JSON.stringify(value)}});
 expect((await executeProductionCaoLearning({...input,trigger:'manual_force'},new AbortController().signal)).status).toBe('completed');
 expect(useJarvisLearningStore.getState().currentProfile().caoGuidance!.sections.corrections).toEqual(prior);
});

it('does not re-evaluate old account messages merely because the active project changes', async () => {
 useJarvisLearningStore.getState().markEvaluated(20);
 useJarvisLearningStore.getState().recordUserMessage({text:'New project setup: work only in this assigned directory and wait for details.',chatId:'new-chat'});
 await reviewCaoChatLearning('account','new-chat',new AbortController().signal);
 expect(mocks.dispatch).not.toHaveBeenCalled();
});
