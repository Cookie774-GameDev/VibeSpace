import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSyncQueueOwner } from '@/lib/cloudSyncQueueOwner';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { fromJarvisRunRow, toJarvisEventRow, toJarvisRunRow } from '@/lib/db/jarvisMappers';
import {
  createKernelTurnTransactionAuthority,
  type KernelLifecycleTransactionContext,
  type KernelTurnTransactionAuthority,
} from '@/lib/db/kernelTurnTransactionAuthority';
import type { SignalBoundTransactionResult } from '@/lib/db/signalBoundTransaction';
import { cloudSyncQueueOwnerKey } from '@/lib/cloudSyncQueueOwner';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { Chat, ChatId, Message, MessageId, WorkspaceId } from '@/types';
import type {
  JarvisArtifactV1,
  JarvisEvent,
  JarvisRun,
  JarvisTransportAttemptV1,
} from './contracts';
import type { JarvisKernelAccountBinding } from './kernelRuntime';
import { createKernelTurnCommit, type KernelTurnCommitInput } from './kernelTurnCommit';

const NOW = 1_786_300_000_000;

function attempt(overrides: Partial<JarvisTransportAttemptV1> = {}): JarvisTransportAttemptV1 {
  return {
    schemaVersion: 1,
    attemptNumber: 1,
    kind: 'initial',
    requestId: 'request-kernel',
    state: 'provider_in_flight',
    startedEventSeq: 1,
    effectBarrier: { state: 'open', version: 0, updatedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function run(overrides: Partial<JarvisRun> = {}): JarvisRun {
  return {
    id: 'run-kernel',
    accountId: 'account-kernel',
    workspaceId: 'workspace-kernel',
    chatId: 'chat-kernel',
    source: 'schedule',
    status: 'running',
    agentId: 'agent-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-kernel',
    model: {
      connectionId: 'connection-kernel',
      providerId: 'provider-kernel',
      modelId: 'model-kernel',
      connectionMode: 'native-api',
      capabilities: { tools: true, vision: false },
      effectiveTemperature: 0.2,
      capturedAt: NOW - 10,
    },
    createdAt: NOW - 20,
    updatedAt: NOW,
    transportAttempts: [attempt()],
    ...overrides,
  };
}

function chat(): Chat {
  return {
    id: 'chat-kernel' as ChatId,
    workspace_id: 'workspace-kernel' as WorkspaceId,
    title: 'Kernel turn',
    mode: 'chat',
    active_agent_ids: [],
    connection: {
      id: 'connection-kernel',
      adapterId: 'openai-native',
      providerId: 'openai',
      displayName: 'OpenAI',
      mode: 'native-api',
      authSource: 'api-key',
      capabilities: {
        text: true,
        images: false,
        files: false,
        tools: true,
        modelSelection: true,
        structuredOutput: true,
        streaming: true,
        cancellation: true,
        resumeSession: false,
        systemPrompt: true,
        workingDirectory: false,
        usage: true,
        subscriptionQuota: false,
        localOnly: false,
      },
      promptTransport: 'native-system',
      enabled: true,
    },
    created_at: NOW - 20,
    updated_at: NOW,
  };
}

function assistantMessage(): Message {
  return {
    id: 'message-kernel' as MessageId,
    chat_id: 'chat-kernel' as ChatId,
    role: 'assistant',
    parts: [{ kind: 'text', text: 'Kernel committed.' }],
    created_at: NOW + 10,
    updated_at: NOW + 10,
  };
}

function actionMessage(status: 'pending' | 'success' | 'error' = 'pending'): Message {
  return {
    ...assistantMessage(),
    parts: [
      { kind: 'text', text: 'Canonical action response.' },
      {
        kind: 'action_proposal',
        call_id: 'jarvisapproval:jappr_action-ready',
        action_id: 'terminal.create',
        params: {},
        status,
      },
    ],
  };
}

function artifact(overrides: Partial<JarvisArtifactV1> = {}): JarvisArtifactV1 {
  const value: JarvisArtifactV1 = {
    schemaVersion: 1,
    id: 'artifact-kernel',
    runId: 'run-kernel',
    requestId: 'request-kernel',
    attemptNumber: 1,
    state: 'ready',
    kind: 'text',
    title: 'Kernel result',
    safeSummary: 'Verified kernel result.',
    localReference: { kind: 'message_part', value: 'message-kernel' },
    sourceRefs: [],
    createdAt: NOW + 5,
    ...overrides,
  };
  return Object.freeze(value);
}

function terminalEvent(artifacts: readonly JarvisArtifactV1[]): KernelTurnCommitInput['terminal'] {
  return {
    status: 'completed',
    event: {
      idempotencyKey: 'kernel-terminal:request-kernel:1',
      title: 'Kernel turn completed',
      safeSummary: 'The protected turn completed.',
      sourceRefs: [],
      artifactIds: artifacts.map((value) => value.id),
      createdAt: NOW + 10,
    },
  };
}

function providerResultSource() {
  return {
    schemaVersion: 1 as const,
    accountId: 'account-kernel',
    runId: 'run-kernel',
    requestId: 'request-kernel',
    attemptNumber: 1,
    producerKind: 'provider' as const,
    producerIdentity: {
      producerKind: 'provider' as const,
      providerId: 'provider-kernel',
      modelId: 'model-kernel',
      modelSnapshotRef: 'provider-kernel:model-kernel',
    },
    resultRef: 'jprovider_result_request-kernel_1',
    observedAt: NOW + 10,
    phase: 'result' as const,
    state: 'completed' as const,
  };
}

function playbackResultSource(state: 'completed' | 'degraded' = 'completed') {
  return {
    schemaVersion: 1 as const,
    accountId: 'account-kernel',
    runId: 'run-kernel',
    requestId: 'request-kernel',
    attemptNumber: 1,
    producerKind: 'voice' as const,
    producerIdentity: {
      producerKind: 'voice' as const,
      sessionId: 'test-voice-session',
      engineKind: 'playback' as const,
      executionId: 'test-playback-execution',
    },
    resultRef: 'voice-playback-result',
    observedAt: NOW + 19,
    phase: 'result' as const,
    state,
  };
}

function binding(controller = new AbortController()) {
  const assertCurrent = vi.fn(() => {
    if (controller.signal.aborted) throw new Error('account authority revoked');
  });
  const value = Object.freeze({
    identity: Object.freeze({ accountId: 'account-kernel', source: 'local' as const }),
    syncOwnerSnapshot: Object.freeze({ state: 'unbound' as const, capturedAt: NOW }),
    revocationSignal: controller.signal,
    assertCurrent,
    dispose: vi.fn(),
  }) as unknown as JarvisKernelAccountBinding;
  return { value, controller, assertCurrent };
}

describe('createKernelTurnCommit', () => {
  let db: JarvisDexie;

  beforeEach(async () => {
    db = createJarvisDb(uniqueTestDbName('kernel-turn-commit'), TEST_INDEXED_DB);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  async function seed(overrides: Partial<JarvisRun> = {}) {
    const current = run(overrides);
    await db.jarvis_runs.add(toJarvisRunRow(current));
    await db.chats.add(chat());
    const startEvent: JarvisEvent = {
      runId: current.id,
      seq: 1,
      idempotencyKey: 'kernel-provider-start',
      type: 'model',
      status: 'started',
      title: 'Provider started',
      safeSummary: 'Provider dispatch started.',
      sourceRefs: [],
      artifactIds: [],
      createdAt: NOW,
    };
    await db.jarvis_events.add(toJarvisEventRow(startEvent));
    return current;
  }

  function harness(authorityBinding = binding()) {
    const assertIssuedAccountBinding = vi.fn((candidate: JarvisKernelAccountBinding) => {
      if (candidate !== authorityBinding.value) throw new Error('foreign binding');
    });
    const consumeArtifactsForCommit = vi.fn();
    const baseTransactionAuthority = createKernelTurnTransactionAuthority(db);
    const lifecycleCalls: (readonly string[])[] = [];
    const transactionAuthority: KernelTurnTransactionAuthority = {
      transaction: baseTransactionAuthority.transaction,
      lifecycleTransaction<T>(
        tables: readonly ['jarvis_runs', 'jarvis_events'],
        signal: AbortSignal,
        body: (context: KernelLifecycleTransactionContext) => T | Promise<T>,
      ): Promise<SignalBoundTransactionResult<T>> {
        lifecycleCalls.push([...tables]);
        return baseTransactionAuthority.lifecycleTransaction<T>(tables, signal, body);
      },
      approvalTransaction: baseTransactionAuthority.approvalTransaction,
    };
    const commit = createKernelTurnCommit({
      transactionAuthority,
      assertIssuedAccountBinding,
      consumeArtifactsForCommit,
    });
    return {
      ...authorityBinding,
      assertIssuedAccountBinding,
      consumeArtifactsForCommit,
      lifecycleCalls,
      transactionAuthority,
      commit,
    };
  }

  function input(
    accountBinding: JarvisKernelAccountBinding,
    overrides: Partial<KernelTurnCommitInput> = {},
  ): KernelTurnCommitInput {
    const artifacts = [artifact()];
    return {
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      expectedStatus: 'running',
      accountBinding,
      terminal: terminalEvent(artifacts),
      assistantMessage: assistantMessage(),
      artifacts,
      transportAttemptCompletion: { requestId: 'request-kernel', attemptNumber: 1 },
      ...overrides,
    };
  }

  it('atomically commits the terminal run, event, message, chat sync, and artifacts', async () => {
    await seed();
    const state = harness();

    const result = await state.commit.commitKernelTurn(input(state.value));

    expect(result).toMatchObject({ committed: true });
    expect(state.assertIssuedAccountBinding).toHaveBeenCalledTimes(3);
    expect(state.assertCurrent).toHaveBeenCalledTimes(3);
    expect(state.consumeArtifactsForCommit).toHaveBeenCalledOnce();
    expect(state.consumeArtifactsForCommit).toHaveBeenCalledWith({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      artifacts: [expect.objectContaining({ id: 'artifact-kernel' })],
    });

    const storedRun = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    expect(storedRun).toMatchObject({
      status: 'completed',
      updatedAt: NOW + 10,
      completedAt: NOW + 10,
      transportAttempts: [{ state: 'completed', updatedAt: NOW + 10 }],
    });
    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.get('message-kernel' as MessageId)).toEqual(assistantMessage());
    expect(await db.jarvis_artifacts.get('artifact-kernel')).toBeDefined();
    expect((await db.chats.get('chat-kernel' as ChatId))?.updated_at).toBe(NOW + 10);

    const queue = await db.sync_queue.toArray();
    expect(queue).toHaveLength(2);
    expect(queue.map((row) => [row.table, row.op]).sort()).toEqual([
      ['chats', 'update'],
      ['messages', 'insert'],
    ]);
    const chatPayload = queue.find((row) => row.table === 'chats')?.payload;
    expect(chatPayload).not.toHaveProperty('connection');
    for (const row of queue) {
      const ownerRow = await db.settings.get(cloudSyncQueueOwnerKey(row.id));
      expect(parseSyncQueueOwner(row.id, ownerRow?.value)).toMatchObject({ state: 'unbound' });
    }
  });

  it('atomically persists a voice response-ready checkpoint without terminalizing the run', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const state = harness();
    const responseInput = {
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      accountBinding: state.value,
      assistantMessage: assistantMessage(),
      artifacts: [artifact()],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    };

    const first = await state.commit.commitVoiceResponseReady(responseInput);
    const second = await state.commit.commitVoiceResponseReady(responseInput);

    expect(first).toMatchObject({
      committed: true,
      run: { status: 'running' },
      event: {
        type: 'message',
        status: 'response_ready',
        idempotencyKey: 'voice-response-ready:run-kernel:message-kernel',
        title: 'Voice response ready',
        safeSummary: 'The validated response is saved and awaiting playback outcome.',
        artifactIds: ['artifact-kernel'],
      },
      message: { id: 'message-kernel' },
      artifacts: [{ id: 'artifact-kernel' }],
    });
    expect(second).toEqual(first);
    expect(state.consumeArtifactsForCommit).toHaveBeenCalledOnce();

    const storedRun = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    expect(storedRun.status).toBe('running');
    expect(storedRun.completedAt).toBeUndefined();
    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.count()).toBe(1);
    expect(await db.jarvis_artifacts.count()).toBe(1);
    expect(await db.sync_queue.count()).toBe(2);
  });

  it('persists an approval checkpoint and terminalizes only after canonical action evidence', async () => {
    await seed({
      source: 'typed_chat',
      status: 'awaiting_approval',
      transportAttempts: [],
      updatedAt: NOW + 5,
    });
    const state = harness();
    const ready = await state.commit.commitActionResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: 'jappr_action-ready',
      accountBinding: state.value,
      assistantMessage: actionMessage(),
      artifacts: [],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });

    expect(ready).toMatchObject({
      committed: true,
      run: { status: 'awaiting_approval' },
      event: { type: 'message', status: 'approval_required' },
      message: { parts: [expect.anything(), expect.objectContaining({ status: 'pending' })] },
    });
    const awaiting = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    await db.jarvis_runs.put(
      toJarvisRunRow({ ...awaiting, status: 'running', updatedAt: NOW + 11 }),
    );

    const handedOff = await (
      state.commit as typeof state.commit & {
        finalizeActionResponse(input: Record<string, unknown>): Promise<unknown>;
      }
    ).finalizeActionResponse({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: 'jappr_action-ready',
      messageId: 'message-kernel',
      accountBinding: state.value,
      outcome: 'handoff',
      resultRef: 'jhandoff_action-ready',
      completedAt: NOW + 12,
    });

    expect(handedOff).toMatchObject({
      committed: true,
      run: { status: 'running' },
      event: { type: 'tool', status: 'handoff_pending' },
      message: { parts: [expect.anything(), expect.objectContaining({ status: 'queued' })] },
    });
    expect(handedOff).not.toHaveProperty('run.completedAt');

    const finalized = await state.commit.finalizeActionResponse({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: 'jappr_action-ready',
      messageId: 'message-kernel',
      accountBinding: state.value,
      outcome: 'completed',
      resultRef: 'jresult_action-ready',
      completedAt: NOW + 13,
    });

    expect(finalized).toMatchObject({
      committed: true,
      run: { status: 'completed', completedAt: NOW + 13 },
      message: { parts: [expect.anything(), expect.objectContaining({ status: 'success' })] },
    });
    expect(fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!).status).toBe('completed');
    expect((await db.messages.get('message-kernel' as MessageId))?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'success' })]),
    );
    const queued = await db.sync_queue.toArray();
    expect(queued).toHaveLength(2);
    expect(queued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'messages', op: 'insert' }),
        expect.objectContaining({ table: 'chats', op: 'update' }),
      ]),
    );
  });

  it('persists only a bounded approved files.read result on the finalized action part', async () => {
    await seed({
      source: 'typed_chat',
      status: 'awaiting_approval',
      transportAttempts: [],
      updatedAt: NOW + 5,
    });
    const state = harness();
    await state.commit.commitActionResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: 'jappr_action-ready',
      accountBinding: state.value,
      assistantMessage: {
        ...actionMessage(),
        parts: [
          { kind: 'text', text: 'Canonical file read response.' },
          {
            kind: 'action_proposal',
            call_id: 'jarvisapproval:jappr_action-ready',
            action_id: 'files.read',
            params: { path: 'C:\\project\\build-corpus.mjs' },
            status: 'pending',
          },
        ],
      },
      artifacts: [],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });
    const awaiting = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    await db.jarvis_runs.put(
      toJarvisRunRow({ ...awaiting, status: 'running', updatedAt: NOW + 11 }),
    );

    const actionResult = {
      ok: true as const,
      summary: 'Read C:\\project\\build-corpus.mjs.',
      data: {
        path: 'C:\\project\\build-corpus.mjs',
        content: 'const shardSize = 48_000;',
      },
    };
    const finalized = await state.commit.finalizeActionResponse({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: 'jappr_action-ready',
      messageId: 'message-kernel',
      accountBinding: state.value,
      outcome: 'completed',
      resultRef: 'jresult_file-read',
      result: actionResult,
      completedAt: NOW + 12,
    });

    expect(finalized).toMatchObject({
      committed: true,
      message: {
        parts: [
          expect.anything(),
          expect.objectContaining({
            action_id: 'files.read',
            status: 'success',
            result: actionResult,
          }),
        ],
      },
    });
  });

  it('projects each files.read in a ten-file batch onto its own part and only completes the run on the last card', async () => {
    await seed({
      source: 'typed_chat',
      status: 'awaiting_approval',
      transportAttempts: [],
      updatedAt: NOW + 5,
    });
    const firstId = 'jappr_read_01';
    const lastId = 'jappr_read_10';
    const firstResult = {
      ok: true as const,
      summary: 'Read C:\\project\\01_readme.txt.',
      data: { path: 'C:\\project\\01_readme.txt', content: 'Title: Northstar Ledger' },
    };
    const lastResult = {
      ok: true as const,
      summary: 'Read C:\\project\\10_status.html.',
      data: { path: 'C:\\project\\10_status.html', content: '<title>Observatory Page</title>' },
    };
    const state = harness();
    await state.commit.commitActionResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: lastId,
      accountBinding: state.value,
      assistantMessage: {
        ...actionMessage(),
        parts: [
          { kind: 'text', text: 'Ten disk reads require approval.' },
          {
            kind: 'action_proposal',
            call_id: `jarvisapproval:${firstId}`,
            action_id: 'files.read',
            params: { path: 'C:\\project\\01_readme.txt' },
            status: 'pending',
          },
          {
            kind: 'action_proposal',
            call_id: `jarvisapproval:${lastId}`,
            action_id: 'files.read',
            params: { path: 'C:\\project\\10_status.html' },
            status: 'pending',
          },
        ],
      },
      artifacts: [],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });

    const first = await state.commit.finalizeActionResponse({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: firstId,
      messageId: 'message-kernel',
      accountBinding: state.value,
      outcome: 'completed',
      resultRef: 'jresult_read_01',
      result: firstResult,
      completedAt: NOW + 12,
    });

    expect(first).toMatchObject({
      committed: true,
      run: { status: 'awaiting_approval' },
      message: {
        parts: [
          expect.anything(),
          expect.objectContaining({
            action_id: 'files.read',
            status: 'success',
            result: firstResult,
          }),
          expect.objectContaining({ action_id: 'files.read', status: 'pending' }),
        ],
      },
    });
    expect(first).not.toHaveProperty('run.completedAt');
    expect(fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!).status).toBe(
      'awaiting_approval',
    );

    const last = await state.commit.finalizeActionResponse({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      approvalId: lastId,
      messageId: 'message-kernel',
      accountBinding: state.value,
      outcome: 'completed',
      resultRef: 'jresult_read_10',
      result: lastResult,
      completedAt: NOW + 13,
    });

    expect(last).toMatchObject({
      committed: true,
      run: { status: 'completed', completedAt: NOW + 13 },
      message: {
        parts: [
          expect.anything(),
          expect.objectContaining({
            action_id: 'files.read',
            status: 'success',
            result: firstResult,
          }),
          expect.objectContaining({
            action_id: 'files.read',
            status: 'success',
            result: lastResult,
          }),
        ],
      },
    });
  });

  it('fails a voice response-ready attempt mismatch before artifact consumption or writes', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const state = harness();

    await expect(
      state.commit.commitVoiceResponseReady({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        assistantMessage: assistantMessage(),
        artifacts: [artifact({ requestId: 'request-other' })],
        providerResultSource: providerResultSource(),
        createdAt: NOW + 10,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: 'attempt_conflict',
      actualStatus: 'running',
    });

    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
  });

  it('fails closed when only part of a response-ready checkpoint already exists', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    await db.messages.add(assistantMessage());
    const state = harness();

    await expect(
      state.commit.commitVoiceResponseReady({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        assistantMessage: assistantMessage(),
        artifacts: [artifact()],
        providerResultSource: providerResultSource(),
        createdAt: NOW + 10,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: 'response_ready_conflict',
      actualStatus: 'running',
    });

    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.jarvis_artifacts.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
  });

  it('terminalizes a response-ready voice run through the exact two-table lifecycle authority', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const state = harness();
    await expect(
      state.commit.commitVoiceResponseReady({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        assistantMessage: assistantMessage(),
        artifacts: [artifact()],
        providerResultSource: providerResultSource(),
        createdAt: NOW + 10,
      }),
    ).resolves.toMatchObject({ committed: true });
    const result = await state.commit.commitVoicePlayback({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      accountBinding: state.value,
      terminalStatus: 'completed',
      playbackResultSource: playbackResultSource(),
      createdAt: NOW + 20,
    });

    expect(result).toMatchObject({
      committed: true,
      run: { status: 'completed', completedAt: NOW + 20 },
      event: {
        type: 'run_state',
        status: 'completed',
        idempotencyKey: 'voice-terminal:run-kernel:request-kernel:1:completed',
        title: 'Voice playback completed',
        safeSummary: 'The saved response finished verified playback.',
        artifactIds: ['artifact-kernel'],
        producerSourceEvidence: playbackResultSource(),
      },
    });
    expect(state.lifecycleCalls).toEqual([['jarvis_runs', 'jarvis_events']]);
    expect(await db.jarvis_events.count()).toBe(3);
    expect(await db.messages.count()).toBe(1);
    expect(await db.chats.count()).toBe(1);
    expect(await db.sync_queue.count()).toBe(2);
    expect(await db.settings.count()).toBe(2);
    expect(await db.jarvis_artifacts.count()).toBe(1);
  });

  it('returns a phase-two status conflict without changing response-ready rows', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const state = harness();
    await state.commit.commitVoiceResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      accountBinding: state.value,
      assistantMessage: assistantMessage(),
      artifacts: [artifact()],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });
    const current = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    await db.jarvis_runs.put(
      toJarvisRunRow({
        ...current,
        status: 'cancelled',
        updatedAt: NOW + 15,
        completedAt: NOW + 15,
      }),
    );

    await expect(
      state.commit.commitVoicePlayback({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        terminalStatus: 'completed',
        createdAt: NOW + 20,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: 'status_conflict',
      actualStatus: 'cancelled',
    });

    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.count()).toBe(1);
    expect(await db.jarvis_artifacts.count()).toBe(1);
  });

  it('rolls back the phase-two run update when the terminal event write fails', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const state = harness();
    await state.commit.commitVoiceResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      accountBinding: state.value,
      assistantMessage: assistantMessage(),
      artifacts: [artifact()],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });
    vi.spyOn(db.jarvis_events, 'add').mockRejectedValueOnce(
      new Error('injected terminal event failure'),
    );

    await expect(
      state.commit.commitVoicePlayback({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        terminalStatus: 'completed',
        createdAt: NOW + 20,
      }),
    ).rejects.toThrow('injected terminal event failure');

    const afterFailure = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    expect(afterFailure.status).toBe('running');
    expect(afterFailure.completedAt).toBeUndefined();
    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.count()).toBe(1);
    expect(await db.jarvis_artifacts.count()).toBe(1);
  });

  it('rolls back phase two and reports authority revocation during settlement', async () => {
    await seed({ source: 'voice', transportAttempts: [] });
    const authorityBinding = binding();
    const state = harness(authorityBinding);
    await state.commit.commitVoiceResponseReady({
      accountId: 'account-kernel',
      runId: 'run-kernel',
      requestId: 'request-kernel',
      attemptNumber: 1,
      accountBinding: state.value,
      assistantMessage: assistantMessage(),
      artifacts: [artifact()],
      providerResultSource: providerResultSource(),
      createdAt: NOW + 10,
    });
    const add = db.jarvis_events.add.bind(db.jarvis_events);
    vi.spyOn(db.jarvis_events, 'add').mockImplementationOnce((row) =>
      add(row).then((result) => {
        authorityBinding.controller.abort('account changed during voice terminal commit');
        return result;
      }),
    );

    await expect(
      state.commit.commitVoicePlayback({
        accountId: 'account-kernel',
        runId: 'run-kernel',
        requestId: 'request-kernel',
        attemptNumber: 1,
        accountBinding: state.value,
        terminalStatus: 'completed',
        createdAt: NOW + 20,
      }),
    ).resolves.toEqual({ committed: false, reason: 'account_authority_revoked' });

    const afterRevocation = fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!);
    expect(afterRevocation.status).toBe('running');
    expect(afterRevocation.completedAt).toBeUndefined();
    expect(await db.jarvis_events.count()).toBe(2);
    expect(await db.messages.count()).toBe(1);
    expect(await db.jarvis_artifacts.count()).toBe(1);
  });

  it('commits an artifact-free terminal turn without invoking the pending-artifact consumer', async () => {
    await seed({ source: 'typed_chat', transportAttempts: [] });
    const state = harness();

    const result = await state.commit.commitKernelTurn(
      input(state.value, {
        artifacts: [],
        terminal: terminalEvent([]),
        transportAttemptCompletion: undefined,
      }),
    );

    expect(result).toMatchObject({ committed: true, artifacts: [] });
    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.messages.get('message-kernel' as MessageId)).toEqual(assistantMessage());
    expect(await db.jarvis_artifacts.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(2);
  });

  it('rejects an unsettled scheduled provider attempt when completion metadata is omitted', async () => {
    await seed();
    const state = harness();

    await expect(
      state.commit.commitKernelTurn(input(state.value, { transportAttemptCompletion: undefined })),
    ).resolves.toEqual({
      committed: false,
      reason: 'attempt_conflict',
      actualStatus: 'running',
    });

    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });

  it.each([
    {
      name: 'status conflict',
      runOverrides: { status: 'awaiting_approval' as const },
      inputOverrides: {},
      expected: { committed: false, reason: 'status_conflict', actualStatus: 'awaiting_approval' },
    },
    {
      name: 'attempt conflict',
      runOverrides: {
        transportAttempts: [attempt({ requestId: 'request-other' })],
      },
      inputOverrides: {},
      expected: { committed: false, reason: 'attempt_conflict', actualStatus: 'running' },
    },
  ])('returns $name with no writes or artifact consumption', async (example) => {
    await seed(example.runOverrides);
    const state = harness();

    await expect(
      state.commit.commitKernelTurn(input(state.value, example.inputOverrides)),
    ).resolves.toEqual(example.expected);

    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });

  it('maps a revoked binding before the transaction to an authority result with no reads or writes', async () => {
    await seed();
    const authorityBinding = binding();
    const state = harness(authorityBinding);
    authorityBinding.controller.abort('account switched');
    const runGet = vi.spyOn(db.jarvis_runs, 'get');

    await expect(state.commit.commitKernelTurn(input(state.value))).resolves.toEqual({
      committed: false,
      reason: 'account_authority_revoked',
    });

    expect(runGet).not.toHaveBeenCalled();
    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.messages.count()).toBe(0);
  });

  it('rechecks authority after every awaited guard immediately before artifact consumption', async () => {
    await seed();
    const state = harness();
    state.assertCurrent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('revoked after guards');
      });

    await expect(state.commit.commitKernelTurn(input(state.value))).resolves.toEqual({
      committed: false,
      reason: 'account_authority_revoked',
    });

    expect(state.assertCurrent).toHaveBeenCalledTimes(3);
    expect(state.consumeArtifactsForCommit).not.toHaveBeenCalled();
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });

  it('maps revocation during settlement only after all database writes roll back', async () => {
    const originalRun = await seed();
    const authorityBinding = binding();
    const state = harness(authorityBinding);
    const bulkAdd = db.jarvis_artifacts.bulkAdd.bind(db.jarvis_artifacts);
    vi.spyOn(db.jarvis_artifacts, 'bulkAdd').mockImplementationOnce((rows) =>
      bulkAdd(rows).then((result) => {
        authorityBinding.controller.abort('account switched during settlement');
        return result;
      }),
    );

    await expect(state.commit.commitKernelTurn(input(state.value))).resolves.toEqual({
      committed: false,
      reason: 'account_authority_revoked',
    });

    expect(state.consumeArtifactsForCommit).toHaveBeenCalledOnce();
    expect(fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!)).toEqual(originalRun);
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });

  it('rolls back all seven tables when the final artifact write fails', async () => {
    const originalRun = await seed();
    const state = harness();
    vi.spyOn(db.jarvis_artifacts, 'bulkAdd').mockRejectedValueOnce(
      new Error('injected artifact write failure'),
    );

    await expect(state.commit.commitKernelTurn(input(state.value))).rejects.toThrow(
      'injected artifact write failure',
    );

    expect(fromJarvisRunRow((await db.jarvis_runs.get('run-kernel'))!)).toEqual(originalRun);
    expect(await db.jarvis_events.count()).toBe(1);
    expect(await db.messages.count()).toBe(0);
    expect(await db.sync_queue.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    expect(await db.jarvis_artifacts.count()).toBe(0);
  });
});
