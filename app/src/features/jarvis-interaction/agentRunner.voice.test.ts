import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import { launchJarvisChatAgent } from './agentRunner';

vi.mock('./sessionStore', () => ({
  useJarvisInteractionStore: {
    getState: () => ({ upsertAgent: vi.fn(), updateAgent: vi.fn() }),
  },
}));

const parentChat = {
  id: 'parent-chat',
  workspace_id: 'workspace-1',
  title: 'Voice chat',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 10,
  updated_at: 10,
};

function createHarness() {
  const createdChats: Record<string, unknown>[] = [];
  const createdMessages: Record<string, unknown>[] = [];
  const dispatched: CustomEvent[] = [];
  const repos = {
    chatRepo: {
      getById: vi.fn(async () => parentChat),
      create: vi.fn(async (chat: Record<string, unknown>) => {
        createdChats.push(chat);
      }),
    },
    messageRepo: {
      create: vi.fn(async (message: Record<string, unknown>) => {
        createdMessages.push(message);
      }),
    },
  };
  const dispatchEvent = vi.fn((event: CustomEvent) => dispatched.push(event));
  let chatIndex = 0;
  let agentIndex = 0;
  const createId = (prefix: 'chat' | 'agent') =>
    prefix === 'chat' ? `child-${++chatIndex}` : `agent-${++agentIndex}`;
  return { createdChats, createdMessages, dispatched, repos, dispatchEvent, createId };
}

describe('voice worker launch in launchJarvisChatAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists provider affinity and screenshot parts before dispatch without duplicating the parent turn', async () => {
    const harness = createHarness();
    const image = {
      id: 'screen-1',
      name: 'screen.png',
      mimeType: 'image/png',
      data: 'c2NyZWVu',
      size: 6,
    };
    const modelSelection: ChatModelSelection = {
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      connectionId: CODEX_CLI_CONNECTION.id,
      connectionMode: CODEX_CLI_CONNECTION.mode,
      authSource: CODEX_CLI_CONNECTION.authSource,
      capabilities: CODEX_CLI_CONNECTION.capabilities,
    };

    const result = await launchJarvisChatAgent({
      parentChatId: 'parent-chat',
      task: 'Inspect the current screen and summarize it.',
      modelLabel: 'GPT-5.6 Sol',
      modelSelection,
      workerProvider: 'codex',
      imageAttachments: [image],
      recordParentCommand: false,
      repos: harness.repos as never,
      dispatchEvent: harness.dispatchEvent,
      now: '2026-09-27T15:00:00.000Z',
      createId: harness.createId,
    });

    const child = harness.createdChats[0]!;
    expect(child.backend_affinity).toEqual({
      version: 1,
      backend: 'codex',
      locked: false,
      selectedAt: Date.parse('2026-09-27T15:00:00.000Z'),
    });
    expect(harness.createdMessages).toHaveLength(2);
    expect(
      harness.createdMessages.some(
        (message) => message.chat_id === 'parent-chat' && message.role === 'user',
      ),
    ).toBe(false);
    expect(harness.createdMessages[1]).toMatchObject({
      chat_id: 'child-1',
      role: 'user',
      parts: [
        { kind: 'text' },
        { kind: 'image', url: 'data:image/png;base64,c2NyZWVu', alt: 'screen.png' },
      ],
    });
    expect(harness.dispatched[0]?.type).toBe('jarvis:send');
    expect(result.agents[0]?.modelLabel).toBe('Codex · GPT-5.6 Sol');
    expect(result.agents[0]?.modelSelection).toEqual(modelSelection);
  });

  it('rejects a worker provider whose selected model belongs to another connection before creating a child', async () => {
    const harness = createHarness();
    const modelSelection: ChatModelSelection = {
      mode: 'single',
      providerId: 'openai',
      modelId: 'openai/gpt-5.6-sol',
      connectionId: OPENCODE_CLI_CONNECTION.id,
      connectionMode: OPENCODE_CLI_CONNECTION.mode,
      authSource: OPENCODE_CLI_CONNECTION.authSource,
      capabilities: OPENCODE_CLI_CONNECTION.capabilities,
    };

    await expect(
      launchJarvisChatAgent({
        parentChatId: 'parent-chat',
        task: 'Do this task',
        modelLabel: 'OpenCode · GPT-5.6 Sol',
        modelSelection,
        workerProvider: 'codex',
        repos: harness.repos as never,
        dispatchEvent: harness.dispatchEvent,
        createId: harness.createId,
      }),
    ).rejects.toThrow(/does not match the selected model connection/i);

    expect(harness.repos.chatRepo.create).not.toHaveBeenCalled();
    expect(harness.dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps existing callers on the legacy OpenCode affinity and parent command behavior', async () => {
    const harness = createHarness();
    await launchJarvisChatAgent({
      parentChatId: 'parent-chat',
      task: 'Do the task',
      modelLabel: 'Existing model',
      repos: harness.repos as never,
      dispatchEvent: harness.dispatchEvent,
      createId: harness.createId,
    });

    expect(harness.createdChats[0]?.backend_affinity).toBeUndefined();
    expect(harness.createdMessages).toHaveLength(3);
    expect(harness.createdMessages[0]).toMatchObject({
      chat_id: 'parent-chat',
      role: 'user',
      parts: [{ kind: 'text' }],
    });
  });
});
