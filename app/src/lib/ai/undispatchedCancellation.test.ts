import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { fromJarvisRunRow, toJarvisRunRow } from '@/lib/db/jarvisMappers';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import type { Agent, ChatId, WorkspaceId } from '@/types';
import type { JarvisRun } from '@/lib/jarvis/contracts';
import type { JarvisKernelTurnInput } from '@/lib/jarvis/kernel';
import { createJarvisKernelRuntime } from '@/lib/jarvis/kernelRuntime';
import { createJarvisAbortRegistry } from '@/lib/jarvis/executionJournal/abortRegistry';
import { settleUndispatchedCancellation } from './undispatchedCancellation';
const NOW = 1_786_300_100_000;

function artifactAuthorities() {
  const ready = (producerId: string) =>
    Object.freeze({
      state: 'ready' as const,
      producerId,
      authority: Object.freeze({ verify: vi.fn(async (value: unknown) => value) }),
    });
  return Object.freeze({
    provider: ready('provider_response'),
    fileAction: ready('file_action_result'),
    terminal: ready('terminal_exit'),
    plugin: ready('plugin_result'),
    mcp: ready('mcp_result'),
    schedule: Object.freeze({
      state: 'unavailable' as const,
      producerId: 'schedule_result',
      reason: 'producer_task_not_landed' as const,
    }),
  });
}

function unavailableVerifiers() {
  const unavailable = <K extends string>(producerKind: K) =>
    Object.freeze({
      state: 'unavailable' as const,
      producerKind,
      reason: 'producer_task_not_landed' as const,
    });
  return Object.freeze({
    provider: unavailable('provider'),
    action: unavailable('action'),
    fileAction: unavailable('file_action'),
    terminal: unavailable('terminal'),
    plugin: unavailable('plugin'),
    mcp: unavailable('mcp'),
    voice: unavailable('voice'),
    schedule: unavailable('schedule'),
    hive: unavailable('hive'),
  });
}

function kernelRun(): JarvisRun {
  return {
    id: 'run-runtime-kernel',
    accountId: 'account-kernel',
    workspaceId: 'workspace-kernel',
    chatId: 'chat-runtime-kernel',
    source: 'typed_chat',
    status: 'queued',
    agentId: 'agent-runtime-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-runtime-kernel',
    model: {
      connectionId: 'connection-runtime-kernel',
      providerId: 'provider-kernel',
      modelId: 'model-kernel',
      connectionMode: 'native-api',
      capabilities: { tools: true, vision: false },
      capturedAt: NOW - 10,
    },
    createdAt: NOW - 20,
    updatedAt: NOW - 20,
  };
}

function kernelTurn(): JarvisKernelTurnInput {
  const current = kernelRun();
  const protectedJarvis: Agent = {
    id: 'agent-runtime-jarvis' as Agent['id'],
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Protected Jarvis',
    system_prompt: 'Legacy prompt.',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    builtin: true,
    created_at: NOW - 20,
    updated_at: NOW - 20,
  };
  return {
    run: current,
    attempt: {
      kind: 'initial',
      requestId: 'request-runtime-kernel',
      runId: current.id,
      attemptNumber: 1,
    },
    accountId: current.accountId,
    workspaceId: current.workspaceId,
    chatId: current.chatId!,
    userMessageId: 'message-runtime-user',
    agent: protectedJarvis,
    surface: 'typed_chat',
    interactionMode: 'ask',
    userText: 'Give me the runtime answer.',
    messageHistory: [{ role: 'user', content: 'Give me the runtime answer.' }],
    model: current.model,
    identity: {
      identityVersion: 1,
      coreHash: 'core-runtime-kernel',
      responseContractHash: 'response-runtime-kernel',
    },
    profile: {
      profileId: 'profile-runtime-kernel',
      revisionId: 'profile-runtime-kernel',
      customInstructions: '',
      memoryScope: 'profile',
    },
    capabilities: {
      capturedAt: NOW - 10,
      tools: [],
      plugins: [],
      mcps: [],
      terminals: [],
      agents: [],
      entitlements: { source: 'local_development', capabilities: [] },
    },
    context: { items: [], budget: { maxChars: 4_000, usedChars: 0 }, exclusions: [] },
    outputContract: {
      preserveStructuredBlocks: true,
      allowActionBlocks: true,
      allowPlanBlocks: true,
      allowQuestionBlocks: true,
      allowPermissionBlocks: true,
      voiceDelivery: 'validated_stream',
    },
  };
}



describe('pending cancellation before kernel dispatch', () => {
  let db: JarvisDexie;
  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('s61-early-stop'), TEST_INDEXED_DB);
    await db.open();
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-kernel' });
  });
  afterEach(async () => { await db.delete(); });

  it.each([['typed_chat', false], ['typed_chat', true], ['voice', false], ['voice', true], ['hive_final', false], ['hive_final', true]] as const)('settles stopped %s with pending intent %s without provider start', async (surface, priorIntent) => {
    const base = kernelTurn(); const turn = { ...base, surface, run: { ...base.run, source: surface } };
    await db.jarvis_runs.add(toJarvisRunRow(turn.run));
    await db.chats.add({ id: turn.chatId as ChatId, workspace_id: turn.workspaceId as WorkspaceId,
      title: 'Early Stop', mode: 'chat', active_agent_ids: [turn.agent.id],
      created_at: NOW - 20, updated_at: NOW - 20 });
    const getRun = async (accountId: string, runId: string) => {
      const row = await db.jarvis_runs.get(runId);
      return row && row.account_id === accountId ? fromJarvisRunRow(row) : undefined;
    };
    const registry = createJarvisAbortRegistry({ getRun,
      newCancellationRequestId: () => 's61-cancel-before-dispatch' });
    const start = vi.fn(() => { throw new Error('provider must never start'); });
    const runtime = createJarvisKernelRuntime({ db,
      artifactEvidenceAuthorities: artifactAuthorities() as never,
      journal: { allocateRun: vi.fn(), getRun },
      cancellationDeliveryAuthority: registry.cancellationDeliveryAuthority,
      abortRegistrationAuthority: registry.registrationAuthority,
      bindKernelActions: vi.fn() as never,
      liveEvidenceVerifiers: unavailableVerifiers() as never,
      prepareProvider: vi.fn(async () => ({
        resolveConfiguration: vi.fn(async () => ({ start, dispose: vi.fn() })),
        dispose: vi.fn(),
      })), processResponse: vi.fn(), takeProviderArtifactDrafts: vi.fn(() => []),
      randomUUID: () => 's61-cancel-runtime-uuid', now: () => NOW,
    });
    if (priorIntent) {
      const cancelled = await runtime.kernel.requestCancellation({ accountId: turn.accountId, runId: turn.run.id });
      expect(cancelled.kind).toBe('intent_committed');
    }
    expect((await getRun(turn.accountId, turn.run.id))?.status).toBe('queued');
    const controller = new AbortController();
    controller.abort();
    await expect(settleUndispatchedCancellation(runtime.kernel, turn, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
    expect((await getRun(turn.accountId, turn.run.id))?.status).toBe('cancelled');
    const events = await db.jarvis_events.toArray();
    expect(events.some(event => event.status === 'cancelled')).toBe(true);
    expect(events.some(event => event.type === 'provider_attempt' && event.status === 'started')).toBe(false);
  });
});
