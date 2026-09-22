import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setDiscoveredConnectionModels,
  resetDiscoveredConnectionModelsForTests,
} from '@/lib/ai/connectionCatalog';
import { readChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import {
  clearChatReasoningPreferences,
  writeChatReasoningEffort,
} from '@/features/chat/reasoningSlashStore';
import type { JarvisDexie } from '@/lib/db/database';
import type { Chat } from '@/types/chat';
import { createCaoChatSnapshotAdapter } from './chatSnapshotAdapter';

vi.mock('@/features/chat/runtime/chatRuntimeSettingsStore', () => ({
  readChatRuntimePolicyState: vi.fn(() => ({
    settings: { effort: 'high' },
    access: 'full',
    approveAllForRun: false,
  })),
}));

const identity = {
  backend: 'codex' as const,
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'high',
};

const baseChat: Chat = {
  id: 'chat-1' as Chat['id'],
  workspace_id: 'workspace-1' as Chat['workspace_id'],
  project_id: 'project-1' as Chat['project_id'],
  title: 'Target',
  mode: 'chat' as const,
  active_agent_ids: [],
  connection: {
    id: identity.connectionId,
    adapterId: 'codex-cli',
    providerId: identity.providerId,
    displayName: 'Codex',
    mode: 'external-cli' as const,
    authSource: 'subscription',
    modelId: identity.modelId,
    capabilities: {} as never,
    promptTransport: 'native-system' as const,
    enabled: true,
  },
  backend_affinity: {
    version: 1 as const,
    backend: identity.backend,
    locked: true,
    selectedAt: 1,
    lockedAt: 1,
  },
  created_at: 1,
  updated_at: 2,
};

function databaseFor(chat: Chat, sourceMessages: readonly unknown[] = []): JarvisDexie {
  let queryMessages = [...sourceMessages];
  const query = {
    between: () => query,
    reverse: () => {
      queryMessages.reverse();
      return query;
    },
    limit: (count: number) => {
      queryMessages = queryMessages.slice(0, count);
      return query;
    },
    toArray: vi.fn(async () => queryMessages),
  };
  return {
    chats: { get: vi.fn(async () => chat) },
    workspaces: { get: vi.fn(async () => ({ id: 'workspace-1', owner_id: 'account-1' })) },
    messages: {
      where: () => query,
    },
  } as unknown as JarvisDexie;
}

const request = {
  missionId: 'mission-1',
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  targetId: 'chat-1',
  assignment: 'Observe the target',
  ownedPaths: ['src'],
};

beforeEach(() => {
  clearChatReasoningPreferences();
  vi.mocked(readChatRuntimePolicyState).mockReturnValue({
    settings: { effort: 'high' },
    access: 'full',
    approveAllForRun: false,
  } as ReturnType<typeof readChatRuntimePolicyState>);
  setDiscoveredConnectionModels(identity.connectionId, [
    {
      id: identity.modelId,
      label: 'GPT-5.6 Luna',
      variants: ['low', 'high'],
      source: 'cli_model',
      lastVerifiedAt: 1,
    },
  ]);
});

afterEach(() => {
  clearChatReasoningPreferences();
  resetDiscoveredConnectionModelsForTests();
});

describe('CAO chat snapshot identity', () => {
  it('uses the same explicit effort and legacy backend resolution as the team picker', async () => {
    vi.mocked(readChatRuntimePolicyState).mockReturnValue({
      settings: { effort: 'auto' },
      access: 'full',
      approveAllForRun: false,
    } as ReturnType<typeof readChatRuntimePolicyState>);
    writeChatReasoningEffort('chat-1', 'low');
    const readSnapshot = createCaoChatSnapshotAdapter({
      database: databaseFor({ ...baseChat, backend_affinity: undefined }),
      identity: { ...identity, reasoningEffort: 'low' },
      now: () => 100,
    });
    await expect(readSnapshot(request)).resolves.toMatchObject({
      backend: 'codex',
      reasoningEffort: 'low',
    });
    writeChatReasoningEffort('chat-1', 'high');
    await expect(readSnapshot(request)).rejects.toThrow('cao_chat_snapshot_identity_mismatch');
  });

  it('rejects a route no longer present in the verified live catalog', async () => {
    resetDiscoveredConnectionModelsForTests();
    await expect(
      createCaoChatSnapshotAdapter({ database: databaseFor(baseChat), identity })(request),
    ).rejects.toThrow('cao_chat_snapshot_identity_mismatch');
  });

  it('uses the current chat route identity when it matches the mission profile', async () => {
    const readSnapshot = createCaoChatSnapshotAdapter({
      database: databaseFor(baseChat),
      identity,
      now: () => 100,
    });

    await expect(readSnapshot(request)).resolves.toMatchObject({
      backend: identity.backend,
      providerId: identity.providerId,
      modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort,
    });
  });

  it('fails closed when the chat route changes after mission start', async () => {
    const changedChat = {
      ...baseChat,
      connection: { ...baseChat.connection, modelId: 'gpt-5.6-sol' },
    } as Chat;
    const readSnapshot = createCaoChatSnapshotAdapter({
      database: databaseFor(changedChat),
      identity,
    });

    await expect(readSnapshot(request)).rejects.toThrow('cao_chat_snapshot_identity_mismatch');
  });

  it('keeps the newest 40 messages and restores chronological order', async () => {
    const sourceMessages = Array.from({ length: 45 }, (_, index) => ({
      id: `message-${index + 1}`,
      chat_id: 'chat-1',
      role: 'assistant' as const,
      parts: [{ kind: 'text' as const, text: `message-${index + 1}` }],
      created_at: index + 1,
      updated_at: index + 1,
    }));
    const readSnapshot = createCaoChatSnapshotAdapter({
      database: databaseFor(baseChat, sourceMessages),
      identity,
      now: () => 100,
    });

    const snapshot = await readSnapshot(request);

    expect(snapshot.recentDelta).toBe(
      Array.from({ length: 12 }, (_, index) => `message-${index + 34}`).join(' '),
    );
    expect(snapshot.recentDelta).not.toMatch(/(?:^| )message-33(?: |$)/u);
  });
});
