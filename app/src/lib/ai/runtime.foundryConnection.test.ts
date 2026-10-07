import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useAgentStore } from '@/stores/agents';
import type { Agent, Chat, ChatId, MessageId, WorkspaceId } from '@/types';
import { resetTurnStoreForTests } from '@/features/chat/runtime/turn/turnStore';
import { foundryModelOptions } from '@/features/model-foundry/modelHub';
import { getFoundryModelOptions, syncFoundryModelOptions } from './models';
import { normalizeChatModelSelection, selectionFromOption } from './modelSelection';

const ports = vi.hoisted(() => ({
  invoke: vi.fn(),
  log: vi.fn(),
  network: vi.fn(),
  error: vi.fn(),
  steps: [] as string[],
  database: null as ReturnType<(typeof import('@/lib/db'))['createJarvisDb']> | null,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ports.invoke }));
vi.mock('@/lib/utils', async (original) => ({
  ...(await original<typeof import('@/lib/utils')>()),
  isTauri: true,
}));
vi.mock('@/features/dev-console', () => ({ devConsole: { log: ports.log } }));
vi.mock('@/components/ui/toast', () => ({
  toast: { error: ports.error, info: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/nativeFetch', () => ({ nativeFetch: ports.network }));
vi.mock('./backend/chatBackendPersistence', async (original) => ({
  ...(await original<typeof import('./backend/chatBackendPersistence')>()),
  dexieChatBackendPersistence: {
    transaction: async (run: () => Promise<unknown>) => {
      ports.steps.push('transaction');
      return ports.database!.transaction(
        'rw',
        ports.database!.chats,
        ports.database!.messages,
        run,
      );
    },
    getChat: (id: ChatId) => {
      ports.steps.push('get-chat-in-transaction');
      return ports.database!.chats.get(id);
    },
    hasCommittedUserMessage: async (id: ChatId) =>
      Boolean(
        await ports
          .database!.messages.where('chat_id')
          .equals(id)
          .and((message) => message.role === 'user')
          .first(),
      ),
    updateChat: (id: ChatId, patch: Pick<Chat, 'backend_affinity'>) =>
      ports.database!.chats.update(id, patch),
  },
}));
vi.mock('@/lib/db', async (original) => {
  const actual = await original<typeof import('@/lib/db')>();
  return {
    ...actual,
    chatRepo: {
      ...actual.chatRepo,
      getById: (id: ChatId) => {
        ports.steps.push('get-chat');
        return ports.database!.chats.get(id);
      },
      update: (id: ChatId, patch: Partial<Chat>) =>
        ports.database!.chats.update(id, patch),
    },
  };
});

vi.mock('./context', () => ({
  extractExplicitReadRoot: () => undefined,
  rememberConversationDestination: () => undefined,
  resolveJarvisContext: async () => ({
    relevantFiles: [],
    enabledCapabilities: [],
    sourceReasons: [],
  }),
  formatResolvedJarvisContext: () => '',
  getExplicitContextBlock: () => '',
  getExplicitFilesBlock: async () => '',
  getExplicitTerminalBlock: () => '',
  buildJarvisContextPackForAi: async (input: { maxChars: number }) => ({
    items: [],
    budget: { maxChars: input.maxChars, usedChars: 0 },
    exclusions: [],
  }),
  getProjectContextBlock: vi.fn(async () => ''),
  getProjectContextTreeBlock: vi.fn(() => ''),
  getConnectedFilesBlock: vi.fn(async () => ''),
  getJarvisCoordinationContextBlock: vi.fn(async () => ''),
  getJarvisTerminalOperatingContextBlock: vi.fn(() => ''),
}));

vi.mock('@/lib/jarvis/connectivityInventory', () => ({
  getJarvisConnectivityInventoryBlock: async () => '',
}));
vi.mock('@/features/terminals/agentContext', () => ({ buildAgentTerminalContext: () => '' }));

import {
  installJarvisKernelRuntimeHost,
  startRuntimeListener,
  type RuntimeBindings,
} from './runtime';

const artifact = {
  id: 'job_foundry_connection',
  name: 'Synthetic verified artifact',
  baseModelId: 'smollm2-135m-instruct',
  method: 'full',
  status: 'completed',
  artifactVerified: true,
  artifactPath: 'C:/synthetic/artifact',
  artifactSha256: 'a'.repeat(64),
  version: 1,
};
const agent: Agent = {
  id: 'agent_jarvis' as Agent['id'],
  slug: 'jarvis',
  name: 'Jarvis',
  description: '',
  system_prompt: 'Answer the synthetic test.',
  model: { provider: 'foundry', model: `artifact--${artifact.id}` },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: true,
  created_at: 1,
  updated_at: 1,
};

afterEach(() => {
  syncFoundryModelOptions([]);
  resetTurnStoreForTests();
  vi.clearAllMocks();
});

describe('Foundry selected artifact through the installed kernel and native bridge', () => {
  it.each([
    { backend: 'opencode', evidence: 'valid' },
    { backend: 'codex', evidence: 'valid' },
    { backend: 'opencode', evidence: 'foreign-artifact' },
    { backend: 'opencode', evidence: 'unverified-artifact' },
    { backend: 'opencode', evidence: 'stale-version' },
    { backend: 'opencode', evidence: 'revoked-account' },
    { backend: 'opencode', evidence: 'missing-binding' },
  ] as const)(
    'uses the exact local connection with $backend and $evidence native evidence',
    async ({ backend, evidence }) => {
      // Native I/O and unrelated empty Context/storage fixture ports are injected.
      // Kernel, connection resolution, router,
      // Foundry provider, bridge validation and journal commit are production code.
      ports.log.mockClear();
      ports.steps.length = 0;
      const eventCalls: string[] = [];
      const eventSpy = vi.spyOn(window, 'addEventListener');
      ports.invoke.mockReset().mockImplementation(async (command: string) => {
        if (command === 'model_foundry_list_jobs')
          return [{ ...artifact, artifactVerified: evidence !== 'unverified-artifact' }];
        if (command === 'model_foundry_chat') {
          if (evidence === 'revoked-account')
            useAuthStore.setState({ localUserId: 'different-current-account' });
          return {
            artifactId: evidence === 'foreign-artifact' ? 'job_foreign' : artifact.id,
            modelName: artifact.name,
            version: evidence === 'stale-version' ? 2 : 1,
            method: 'full',
            text: 'Synthetic local inference completed.',
            inputTokens: 12,
            outputTokens: 5,
          };
        }
        throw new Error(`Unexpected native I/O in Foundry fixture: ${command}`);
      });
      ports.network.mockReset().mockImplementation(() => {
        throw new Error('No cloud or harness transport is authorized in this fixture');
      });
      localStorage.clear();
      const accountId = `foundry-${backend}-account`;
      const chatId = `chat-foundry-${backend}` as ChatId;
      const workspaceId = 'workspace-foundry' as WorkspaceId;
      const userId = `msg-foundry-${backend}` as MessageId;
      useAuthStore.setState({
        cloudSession: null,
        localUserId: accountId,
        workspaceId,
        projectId: null,
        apiKeys: {},
        offlineMode: false,
        plan: 'free',
        stackPreset: 'off',
        speakReplies: false,
        automaticModelRoutingEnabled: false,
      });
      useUIStore.setState({ notificationMaster: false, voiceModalOpen: false });
      useAgentStore.setState({ agents: { [agent.id]: agent } });
      syncFoundryModelOptions(foundryModelOptions([artifact]));
      const option = getFoundryModelOptions().find((row) => row.id === agent.model.model)!;
      const selected =
        evidence === 'missing-binding'
          ? ({ mode: 'single', providerId: option.provider, modelId: option.id } as const)
          : normalizeChatModelSelection(selectionFromOption(option.provider, option.id));
      useAuthStore.setState({ chatModelSelection: selected });
      const database = createJarvisDb(uniqueTestDbName('foundry-connection'), TEST_INDEXED_DB);
      ports.database = database;
      await database.open();
      await database.chats.add({
        id: chatId,
        workspace_id: workspaceId,
        title: 'Synthetic Foundry connection',
        mode: 'chat',
        active_agent_ids: [agent.id],
        created_at: 1,
        updated_at: 1,
        backend_affinity: { version: 1, backend, locked: true, selectedAt: 1, lockedAt: 1 },
      });
      await database.messages.add({
        id: userId,
        chat_id: chatId,
        role: 'user',
        parts: [{ kind: 'text', text: 'Return a short local answer.' }],
        created_at: 1,
        updated_at: 1,
      });
      const bindings: RuntimeBindings = {
        getAgentById: () => agent,
        getAgentBySlug: () => agent,
        getAgentForChat: () => {
          ports.steps.push('agent');
          return agent;
        },
        getMessages: () => {
          ports.steps.push('history');
          return database.messages.where('chat_id').equals(chatId).toArray();
        },
        appendMessage: async (message) => {
          const row = {
            ...message,
            id: crypto.randomUUID() as MessageId,
            created_at: Date.now(),
            updated_at: Date.now(),
          };
          await database.messages.add(row);
          return row;
        },
        updateMessage: async (id, patch) => {
          await database.messages.update(id, patch);
        },
      };
      const disposeHost = await installJarvisKernelRuntimeHost({
        db: database,
        bindKernelActions: () =>
          ({
            create: vi.fn(),
            decide: vi.fn(),
            execute: vi.fn(),
            executeAutoApprovedSafe: vi.fn(),
          }) as never,
        capabilitySnapshots: {
          getForAccount: async () => ({
            capturedAt: 1,
            tools: [],
            plugins: [],
            mcps: [],
            terminals: [],
            agents: [],
            entitlements: { source: 'unavailable', capabilities: [] },
          }),
        },
      });
      const stop = startRuntimeListener(bindings, { jarvisKernelMode: 'kernel' });
      eventCalls.push(...eventSpy.mock.calls.map(([event]) => event));
      try {
        window.dispatchEvent(
          new CustomEvent('jarvis:send', {
            detail: {
              chatId,
              text: 'Return a short local answer.',
              cancellationKey: userId,
              accountId,
              interactionMode: 'ask',
            },
          }),
        );
        if (evidence === 'revoked-account') {
          await vi.waitFor(() =>
            expect(
              ports.invoke.mock.calls.some(([command]) => command === 'model_foundry_chat'),
            ).toBe(true),
          );
          await stop.whenIdle();
        } else {
          await vi.waitFor(
            async () => {
              const rows = await database.jarvis_runs.toArray();
              expect(
                rows.some((run) => run.status === (evidence === 'valid' ? 'completed' : 'failed')),
                JSON.stringify({
                  steps: ports.steps,
                  logs: ports.log.mock.calls,
                  errors: ports.error.mock.calls,
                  events: eventCalls,
                  native: ports.invoke.mock.calls,
                  rows,
                }),
              ).toBe(true);
            },
            { timeout: 5000 },
          );
        }
        const runs = await database.jarvis_runs.toArray();
        expect(runs).toHaveLength(1);
        const stored = JSON.stringify(runs[0]);
        if (evidence !== 'missing-binding') expect(stored).toContain('foundry-local');
        else
          expect(JSON.stringify(ports.log.mock.calls)).toContain(
            'kernel_provider_connection_unavailable',
          );
        expect(stored).toContain(agent.model.model);
        const chatCall = ports.invoke.mock.calls.filter(
          ([command]) => command === 'model_foundry_chat',
        );
        expect(chatCall).toHaveLength(evidence === 'missing-binding' ? 0 : 1);
        if (evidence !== 'missing-binding')
          expect(chatCall[0]?.[1]).toMatchObject({ artifactId: artifact.id });
        expect(ports.network).not.toHaveBeenCalled();
        const messages = await database.messages.where('chat_id').equals(chatId).toArray();
        expect(
          messages.some(
            (message) =>
              message.role === 'assistant' &&
              JSON.stringify(message.parts).includes('Synthetic local inference completed.'),
          ),
        ).toBe(evidence === 'valid');
        if (evidence !== 'valid')
          expect(runs.every((run) => run.status !== 'completed')).toBe(true);
      } finally {
        eventSpy.mockRestore();
        stop();
        await stop.whenIdle();
        disposeHost();
        database.close();
        await database.delete();
      }
    },
    20000,
  );
});
