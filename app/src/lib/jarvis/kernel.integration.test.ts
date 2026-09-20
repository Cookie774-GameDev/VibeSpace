import { describe, expect, it, vi } from 'vitest';

import type { Agent, ChatId, MessageId, WorkspaceId } from '@/types';
import type {
  JarvisArtifactDraft,
  JarvisArtifactV1,
  JarvisApprovalV1,
  JarvisEvent,
  JarvisResponseEnvelope,
  JarvisRun,
} from './contracts';
import type { RawProviderResponse } from './response/pipeline';
import type {
  JarvisBoundKernelLifecycle,
  JarvisKernelDeps,
  JarvisKernelTurnInput,
  JarvisProviderStartedReceipt,
} from './kernel';
import {
  runJarvisKernelScheduledTurn,
  runJarvisKernelTurn,
  runJarvisKernelVoiceTurn,
} from './kernel';
import { JarvisApprovalError } from './approvalEngine';

const NOW = 1_786_300_200_000;

function run(overrides: Partial<JarvisRun> = {}): JarvisRun {
  return {
    id: 'run-kernel-integration',
    accountId: 'account-kernel',
    workspaceId: 'workspace-kernel',
    projectId: 'project-kernel',
    chatId: 'chat-kernel',
    source: 'typed_chat',
    status: 'queued',
    agentId: 'agent-jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-revision-kernel',
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
    updatedAt: NOW - 20,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-jarvis' as Agent['id'],
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Protected Jarvis',
    system_prompt: 'Legacy prompt must not be used.',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    builtin: true,
    created_at: NOW - 20,
    updated_at: NOW - 20,
    ...overrides,
  };
}

function turnInput(overrides: Partial<JarvisKernelTurnInput> = {}): JarvisKernelTurnInput {
  const current = run();
  return {
    run: current,
    attempt: {
      kind: 'initial',
      requestId: 'request-kernel',
      runId: current.id,
      attemptNumber: 1,
    },
    accountId: current.accountId,
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    chatId: current.chatId!,
    userMessageId: 'message-user-kernel',
    agent: agent(),
    surface: 'typed_chat',
    interactionMode: 'ask',
    userText: 'Give me the verified answer.',
    messageHistory: [{ role: 'user', content: 'Give me the verified answer.' }],
    model: current.model,
    identity: {
      identityVersion: 1,
      coreHash: 'core-hash-kernel',
      responseContractHash: 'response-hash-kernel',
    },
    profile: {
      profileId: 'profile-kernel',
      revisionId: 'profile-revision-kernel',
      customInstructions: 'Be concise.',
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
    context: {
      items: [],
      budget: { maxChars: 4_000, usedChars: 0 },
      exclusions: [],
    },
    outputContract: {
      preserveStructuredBlocks: true,
      allowActionBlocks: true,
      allowPlanBlocks: true,
      allowQuestionBlocks: true,
      allowPermissionBlocks: true,
      voiceDelivery: 'validated_stream',
    },
    ...overrides,
  };
}

const PROVIDER_RECEIPT: JarvisProviderStartedReceipt = Object.freeze({
  providerId: 'provider-kernel',
  modelId: 'model-kernel',
  modelSnapshotRef: 'provider-kernel:model-kernel',
  operations: ['generate'] as const,
  startedAt: NOW + 3,
});

function providerResultSource(input: Readonly<JarvisKernelTurnInput>) {
  return {
    schemaVersion: 1 as const,
    accountId: input.accountId,
    runId: input.run.id,
    requestId: input.attempt.requestId,
    attemptNumber: input.attempt.attemptNumber,
    producerKind: 'provider' as const,
    producerIdentity: {
      producerKind: 'provider' as const,
      providerId: PROVIDER_RECEIPT.providerId,
      modelId: PROVIDER_RECEIPT.modelId,
      modelSnapshotRef: PROVIDER_RECEIPT.modelSnapshotRef,
    },
    resultRef: `jresult_${input.attempt.requestId}`,
    observedAt: NOW + 4,
    phase: 'result' as const,
    state: 'completed' as const,
  };
}

function rawResponse(input: Readonly<JarvisKernelTurnInput>): RawProviderResponse {
  return {
    text: 'Verified answer.',
    provider: input.model,
    usage: { input_tokens: 21, output_tokens: 8, cost_usd: 0.0042 },
    verifiedFacts: {
      executionState: {
        status: 'completed',
        verifiedBy: 'journal',
        lastEventSeq: 2,
      },
      modelState: 'authenticated',
      plugins: [],
      mcps: [],
    },
    completedAt: NOW + 4,
  };
}

function processedResponse(input: Readonly<JarvisKernelTurnInput>): JarvisResponseEnvelope {
  return {
    schemaVersion: 1,
    requestId: input.attempt.requestId,
    runId: input.run.id,
    mode: 'direct_answer',
    displayText: 'Verified answer.',
    parts: [{ kind: 'text', text: 'Verified answer.' }],
    artifactIds: [],
    sourceRefs: [],
    executionState: { status: 'completed', verifiedBy: 'journal', lastEventSeq: 2 },
    provider: input.model,
    enforcement: {
      linted: true,
      violations: [],
      repairAttempted: false,
      repairSucceeded: false,
      fallbackUsed: false,
    },
    completedAt: NOW + 4,
  };
}

type KernelHarnessOptions = Readonly<{
  persisted?: JarvisRun;
  response?: Promise<Readonly<RawProviderResponse>>;
  committedEvent?: JarvisEvent;
  onAssertCurrent?: (call: number, authority: AbortController) => void;
  cleanupThrows?: ReadonlySet<'registration' | 'abort' | 'resolved' | 'prepared'>;
  processed?: JarvisResponseEnvelope;
}>;

function createKernelHarness(
  input: Readonly<JarvisKernelTurnInput>,
  options: KernelHarnessOptions = {},
) {
  const authority = new AbortController();
  const cleanupCalls: string[] = [];
  let currentnessCalls = 0;
  const source = providerResultSource(input);
  const terminalEvent: JarvisEvent =
    options.committedEvent ??
    ({
      runId: input.run.id,
      seq: 3,
      idempotencyKey: `kernel-terminal:${input.attempt.requestId}:1`,
      type: 'run_state',
      status: 'completed',
      title: 'Kernel turn completed',
      safeSummary: 'The protected turn completed.',
      sourceRefs: [],
      artifactIds: [],
      createdAt: NOW + 4,
      producerSourceEvidence: source,
    } satisfies JarvisEvent);
  const maybeThrowCleanup = (name: 'registration' | 'abort' | 'resolved' | 'prepared'): void => {
    cleanupCalls.push(name);
    if (options.cleanupThrows?.has(name)) throw new Error(`cleanup_${name}`);
  };
  const providerRegistration = {
    initialProof: Object.freeze({ proofRef: 'jlive_provider-start' }),
    dispose: vi.fn(() => maybeThrowCleanup('registration')),
  };
  const started = {
    receipt: PROVIDER_RECEIPT,
    response: options.response ?? Promise.resolve(rawResponse(input)),
    abortAfterStart: vi.fn(),
  };
  const resolved = {
    start: vi.fn(() => started),
    dispose: vi.fn(() => maybeThrowCleanup('resolved')),
  };
  const prepared = {
    resolveConfiguration: vi.fn(async () => resolved),
    dispose: vi.fn(() => maybeThrowCleanup('prepared')),
  };
  const lifecycle: JarvisBoundKernelLifecycle = {
    revocationSignal: authority.signal,
    assertCurrent: vi.fn(() => {
      currentnessCalls += 1;
      options.onAssertCurrent?.(currentnessCalls, authority);
    }),
    transition: vi.fn(async ({ nextStatus }) => ({
      kind: 'committed' as const,
      value: {
        run: run({ status: nextStatus, updatedAt: NOW + 1 }),
        event: { ...terminalEvent, status: nextStatus },
      },
    })),
    recordProviderStarted: vi.fn(async () => ({
      kind: 'committed' as const,
      value: providerRegistration,
    })),
    recordProviderResult: vi.fn(async () => ({ kind: 'committed' as const, value: {} as never })),
    registerAbortOwner: vi.fn(() => () => maybeThrowCleanup('abort')),
  };
  const commitKernelTurn = vi.fn(
    async (commitInput: Parameters<JarvisKernelDeps['commitKernelTurn']>[0]) => ({
      committed: true as const,
      run: run({ status: 'completed', completedAt: NOW + 4 }),
      event: terminalEvent,
      message: commitInput.assistantMessage,
      artifacts: commitInput.artifacts,
    }),
  );
  const issueBoundLifecycle = vi.fn(() => lifecycle);
  const deps: JarvisKernelDeps = {
    journal: {
      allocateRun: vi.fn(),
      getRun: vi.fn(async () => options.persisted ?? input.run),
    },
    issueBoundLifecycle,
    issueBoundArtifactPipeline: vi.fn(),
    artifactEffectClaims: { claim: vi.fn() },
    takeProviderArtifactDrafts: vi.fn(() => []),
    commitKernelTurn,
    prepareProvider: vi.fn(async () => prepared),
    processResponse: vi.fn(async () => options.processed ?? processedResponse(input)),
    now: () => NOW + 4,
  };
  return {
    authority,
    cleanupCalls,
    commitKernelTurn,
    deps,
    issueBoundLifecycle,
    lifecycle,
    prepared,
    providerRegistration,
    resolved,
    source,
    started,
  };
}

describe('runJarvisKernelTurn explicit kernel integration', () => {
  it('executes a registered safe response action canonically before terminal projection', async () => {
    const input = turnInput();
    const processed: JarvisResponseEnvelope = {
      ...processedResponse(input),
      mode: 'action_success',
      parts: [
        { kind: 'text', text: 'Searching the fixed project.' },
        {
          kind: 'action_proposal',
          call_id: 'jarvis_action_request-kernel_0',
          action_id: 'file.search',
          params: { query: 'smoke fixture', maxResults: 1 },
          status: 'pending',
        },
      ],
    };
    const approval: JarvisApprovalV1 = {
      id: 'jappr_safe-response',
      runId: input.run.id,
      actionId: 'file.search',
      actionVersion: 1,
      params: { query: 'smoke fixture', maxResults: 1 },
      secretHandleRefs: [],
      paramsHash: 'params-safe',
      targetSnapshot: { kind: 'app_resource', namespace: 'files', resourceId: 'search-index' },
      risk: 'safe',
      status: 'consumed',
      createdAt: NOW + 4,
      decidedAt: NOW + 4,
      consumedAt: NOW + 4,
      schemaVersion: 1,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      capabilityId: 'files.read',
      capabilitySnapshotHash: 'capability-safe',
      expectedEffect: 'Reads matching file metadata without modifying files.',
      expiresAt: NOW + 60_000,
    };
    const executeAutoApprovedSafe = vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        approval,
        execution: {
          kind: 'settled' as const,
          result: { ok: true as const, summary: 'Found one matching file.' },
        },
      },
    }));
    const harness = createKernelHarness(input, { processed });
    Object.assign(harness.deps, {
      responseActions: {
        resolveRegistration: vi.fn(() => ({
          id: 'file.search',
          version: 1,
          risk: 'read-only',
          approval: 'never',
        })),
        executeAutoApprovedSafe,
        create: vi.fn(),
      },
      commitActionResponseReady: vi.fn(),
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).resolves.toMatchObject({
      kind: 'committed',
    });

    expect(harness.deps.prepareProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      }),
    );
    expect(executeAutoApprovedSafe).toHaveBeenCalledOnce();
    expect(executeAutoApprovedSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'file.search',
        actionVersion: 1,
        params: { query: 'smoke fixture', maxResults: 1 },
        attempt: input.attempt,
      }),
    );
    expect(harness.commitKernelTurn).toHaveBeenCalledOnce();
    expect(harness.commitKernelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMessage: expect.objectContaining({
          usage: {
            input_tokens: 21,
            output_tokens: 8,
            cost_usd: 0.0042,
            provider: input.agent.model.provider,
            model: PROVIDER_RECEIPT.modelId,
          },
          parts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'action_proposal',
              call_id: 'jarvisapproval:jappr_safe-response',
              action_id: 'file.search',
              status: 'success',
            }),
          ]),
        }),
      }),
    );
  });

  it('materializes exact canonical plugin link outputs before committing the successful action', async () => {
    const input = turnInput();
    const processed: JarvisResponseEnvelope = {
      ...processedResponse(input),
      mode: 'action_success',
      parts: [
        {
          kind: 'action_proposal',
          call_id: 'jarvis_action_request-kernel_0',
          action_id: 'github.repository.read',
          params: { owner: 'octocat', repository: 'hello-world' },
          status: 'pending',
        },
      ],
    };
    const approval: JarvisApprovalV1 = {
      id: 'jappr_plugin-output',
      runId: input.run.id,
      actionId: 'github.repository.read',
      actionVersion: 1,
      params: { owner: 'octocat', repository: 'hello-world' },
      secretHandleRefs: [],
      paramsHash: 'params-plugin',
      targetSnapshot: {
        kind: 'plugin_tool',
        accountId: input.accountId,
        pluginId: 'github',
        toolName: 'repository_context',
        resourceId: 'octocat/hello-world',
      },
      risk: 'safe',
      status: 'consumed',
      createdAt: NOW + 4,
      consumedAt: NOW + 4,
      schemaVersion: 1,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      capabilityId: 'plugin.github.repository.read',
      capabilitySnapshotHash: 'capability-plugin',
      expectedEffect: 'Reads repository metadata.',
      expiresAt: NOW + 60_000,
    };
    const evidence = Object.freeze({
      producerId: 'plugin_result' as const,
      accountId: input.accountId,
      runId: input.run.id,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      resultRef: 'jresult_plugin-output',
      state: 'succeeded' as const,
      verifiedAt: NOW + 5,
      pluginId: 'github',
      invocationId: `approval:${approval.id}`,
    });
    const draft: JarvisArtifactDraft = Object.freeze({
      artifact: Object.freeze({
        kind: 'link' as const,
        title: 'GitHub repository octocat/hello-world',
        state: 'ready' as const,
        safeSummary: 'GitHub repository octocat/hello-world retrieved.',
        sourceRefs: [],
        createdAt: evidence.verifiedAt,
      }),
      backing: Object.freeze({
        kind: 'uri' as const,
        uri: 'https://github.com/octocat/hello-world',
      }),
    });
    const artifact: JarvisArtifactV1 = Object.freeze({
      schemaVersion: 1,
      id: 'jart_plugin-output',
      runId: input.run.id,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      state: 'ready',
      kind: 'link',
      title: 'GitHub repository octocat/hello-world',
      uri: 'https://github.com/octocat/hello-world',
      safeSummary: 'GitHub repository octocat/hello-world retrieved.',
      sourceRefs: [],
      createdAt: evidence.verifiedAt,
    });
    const materialize = vi.fn(async () => artifact);
    const harness = createKernelHarness(input, { processed });
    Object.assign(harness.deps, {
      responseActions: {
        resolveRegistration: vi.fn(() => ({
          id: approval.actionId,
          version: approval.actionVersion,
          risk: 'read-only',
          approval: 'never',
          executor: {
            kind: 'plugin_tool',
            pluginId: 'github',
            toolName: 'repository_context',
          },
        })),
        executeAutoApprovedSafe: vi.fn(async () => ({
          kind: 'committed' as const,
          value: {
            approval,
            execution: {
              kind: 'settled' as const,
              result: {
                ok: true as const,
                summary: 'GitHub repository octocat/hello-world retrieved.',
              },
            },
            pluginArtifacts: Object.freeze([
              Object.freeze({ evidence, drafts: Object.freeze([draft]) }),
            ]),
          },
        })),
        create: vi.fn(),
      },
      issueBoundArtifactPipeline: vi.fn(() => ({
        plugin: { materialize },
      })),
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).resolves.toMatchObject({
      kind: 'committed',
      value: {
        response: { artifactIds: [artifact.id] },
        messageParts: [
          expect.objectContaining({ kind: 'action_proposal' }),
          expect.objectContaining({
            kind: 'jarvis_artifact_ref',
            artifact: expect.objectContaining({ id: artifact.id, uri: artifact.uri }),
          }),
        ],
      },
    });
    expect(materialize).toHaveBeenCalledWith({ evidence, draft });
    expect(harness.commitKernelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [artifact],
        assistantMessage: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'jarvis_artifact_ref',
              artifact: expect.objectContaining({ id: artifact.id }),
            }),
          ]),
        }),
      }),
    );
  });

  it.each([
    {
      label: 'untrusted exception',
      makeFailure: () => new Error('C:\\private\\operator\\secret.txt'),
      expected: 'kernel_safe_action_execution_failed',
    },
    {
      label: 'approval rejection',
      makeFailure: () => new JarvisApprovalError('capability_changed'),
      expected: 'kernel_safe_action_approval_capability_changed',
    },
  ])('reduces a $label to one bounded kernel stage code', async ({ makeFailure, expected }) => {
    const input = turnInput();
    const processed: JarvisResponseEnvelope = {
      ...processedResponse(input),
      mode: 'action_success',
      parts: [
        {
          kind: 'action_proposal',
          call_id: 'jarvis_action_request-kernel_0',
          action_id: 'file.search',
          params: { query: 'smoke fixture', maxResults: 1 },
          status: 'pending',
        },
      ],
    };
    const harness = createKernelHarness(input, { processed });
    Object.assign(harness.deps, {
      responseActions: {
        resolveRegistration: vi.fn(() => ({
          id: 'file.search',
          version: 1,
          risk: 'read-only',
          approval: 'never',
        })),
        executeAutoApprovedSafe: vi.fn(async () => {
          throw makeFailure();
        }),
        create: vi.fn(),
      },
      commitActionResponseReady: vi.fn(),
    });

    const turnFailure = runJarvisKernelTurn(input, harness.deps);
    await expect(turnFailure).rejects.toThrow(expected);
    await expect(turnFailure).rejects.not.toThrow('secret.txt');
  });

  it('persists a canonical pending response action while the run awaits approval', async () => {
    const input = turnInput();
    const processed: JarvisResponseEnvelope = {
      ...processedResponse(input),
      mode: 'approval_required',
      parts: [
        { kind: 'text', text: 'Approval is required.' },
        {
          kind: 'action_proposal',
          call_id: 'jarvis_action_request-kernel_0',
          action_id: 'terminal.create',
          params: {},
          status: 'pending',
        },
      ],
    };
    const approval: JarvisApprovalV1 = {
      id: 'jappr_terminal-response',
      runId: input.run.id,
      actionId: 'terminal.create',
      actionVersion: 1,
      params: {},
      secretHandleRefs: [],
      paramsHash: 'params-terminal',
      targetSnapshot: { kind: 'external_resource', service: 'terminal', resourceId: 'new' },
      risk: 'confirm',
      status: 'pending',
      createdAt: NOW + 4,
      schemaVersion: 1,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      capabilityId: 'terminal.execute',
      capabilitySnapshotHash: 'capability-terminal',
      expectedEffect: 'Creates one terminal process owned by the active account.',
      expiresAt: NOW + 60_000,
    };
    const create = vi.fn(async () => ({ kind: 'committed' as const, value: approval }));
    const commitActionResponseReady = vi.fn(async (commitInput) => ({
      committed: true as const,
      run: run({ status: 'awaiting_approval', updatedAt: NOW + 4 }),
      event: {
        runId: input.run.id,
        seq: 5,
        idempotencyKey: `action-response-ready:${input.attempt.requestId}`,
        type: 'message' as const,
        status: 'approval_required',
        title: 'Action approval required',
        safeSummary: 'The validated response is saved and awaiting an approval decision.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW + 4,
        producerSourceEvidence: harness.source,
      },
      message: commitInput.assistantMessage,
      artifacts: commitInput.artifacts,
    }));
    const harness = createKernelHarness(input, { processed });
    Object.assign(harness.deps, {
      responseActions: {
        resolveRegistration: vi.fn(() => ({
          id: 'terminal.create',
          version: 1,
          risk: 'external-side-effect',
          approval: 'always',
        })),
        executeAutoApprovedSafe: vi.fn(),
        create,
      },
      commitActionResponseReady,
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).resolves.toMatchObject({
      kind: 'committed',
    });

    expect(create).toHaveBeenCalledOnce();
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
    expect(commitActionResponseReady).toHaveBeenCalledOnce();
    expect(commitActionResponseReady).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: approval.id,
        assistantMessage: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'action_proposal',
              call_id: 'jarvisapproval:jappr_terminal-response',
              action_id: 'terminal.create',
              status: 'pending',
            }),
          ]),
        }),
      }),
    );
    expect(harness.lifecycle.recordProviderResult).toHaveBeenCalledOnce();
  });

  it('runs one envelope/compiler/provider/pipeline/projection and commits once in order', async () => {
    const order: string[] = [];
    const input = turnInput();
    const compilingRun = run({ status: 'compiling', updatedAt: NOW + 1 });
    const runningRun = run({ status: 'running', updatedAt: NOW + 2 });
    const completedRun = run({ status: 'completed', updatedAt: NOW + 4, completedAt: NOW + 4 });
    const terminalEvent: JarvisEvent = {
      runId: input.run.id,
      seq: 3,
      idempotencyKey: 'kernel-terminal:request-kernel:1',
      type: 'run_state',
      status: 'completed',
      title: 'Kernel turn completed',
      safeSummary: 'The protected turn completed.',
      sourceRefs: [],
      artifactIds: [],
      createdAt: NOW + 4,
      producerSourceEvidence: providerResultSource(input),
    };
    const processed: JarvisResponseEnvelope = {
      schemaVersion: 1,
      requestId: 'request-kernel',
      runId: input.run.id,
      mode: 'direct_answer',
      displayText: 'Verified answer.',
      spokenText: 'Verified answer.',
      parts: [{ kind: 'text', text: 'Verified answer.' }],
      artifactIds: [],
      sourceRefs: [],
      executionState: { status: 'completed', verifiedBy: 'journal', lastEventSeq: 2 },
      provider: input.model,
      enforcement: {
        linted: true,
        violations: [],
        repairAttempted: false,
        repairSucceeded: false,
        fallbackUsed: false,
      },
      completedAt: NOW + 4,
    };
    const providerRegistration = {
      initialProof: Object.freeze({ proofRef: 'jlive_provider-start' }),
      update: vi.fn(),
      complete: vi.fn(async () => ({ kind: 'committed', value: {} })),
      dispose: vi.fn(() => order.push('provider-registration-dispose')),
    };
    const lifecycle = {
      revocationSignal: new AbortController().signal,
      assertCurrent: vi.fn(() => order.push('authority-current')),
      transition: vi.fn(async ({ nextStatus }: { nextStatus: JarvisRun['status'] }) => {
        order.push(`transition-${nextStatus}`);
        return {
          kind: 'committed' as const,
          value: {
            run: nextStatus === 'compiling' ? compilingRun : runningRun,
            event: { ...terminalEvent, status: nextStatus },
          },
        };
      }),
      registerAbortOwner: vi.fn(() => {
        order.push('register-abort');
        return () => order.push('unregister-abort');
      }),
      recordProviderStarted: vi.fn(async () => {
        order.push('record-provider-started');
        return { kind: 'committed' as const, value: providerRegistration };
      }),
      recordProviderResult: vi.fn(async () => {
        order.push('record-provider-result');
        return { kind: 'committed' as const, value: {} };
      }),
    };
    const resolved = {
      start: vi.fn(() => {
        order.push('provider-start');
        return {
          receipt: {
            providerId: 'provider-kernel',
            modelId: 'model-kernel',
            modelSnapshotRef: 'provider-kernel:model-kernel',
            operations: ['generate'] as const,
            startedAt: NOW + 3,
          },
          response: Promise.resolve({
            text: 'Verified answer.',
            provider: input.model,
            verifiedFacts: {
              executionState: {
                status: 'completed' as const,
                verifiedBy: 'journal' as const,
                lastEventSeq: 2,
              },
              modelState: 'authenticated' as const,
              plugins: [],
              mcps: [],
            },
            completedAt: NOW + 4,
          }),
          abortAfterStart: vi.fn(),
        };
      }),
      dispose: vi.fn(() => order.push('resolved-dispose')),
    };
    const prepared = {
      resolveConfiguration: vi.fn(async () => {
        order.push('resolve-provider');
        return resolved;
      }),
      dispose: vi.fn(() => order.push('prepared-dispose')),
    };
    const commitKernelTurn = vi.fn(async (commitInput) => {
      order.push('commit-turn');
      return {
        committed: true as const,
        run: completedRun,
        event: terminalEvent,
        message: commitInput.assistantMessage,
        artifacts: [],
      };
    });
    const processResponse = vi.fn(async () => {
      order.push('process-response');
      return processed;
    });

    const result = await runJarvisKernelTurn(input, {
      journal: {
        allocateRun: vi.fn(),
        getRun: vi.fn(async () => {
          order.push('read-run');
          return input.run;
        }),
      },
      issueBoundLifecycle: vi.fn(() => lifecycle as never),
      issueBoundArtifactPipeline: vi.fn(),
      artifactEffectClaims: { claim: vi.fn() },
      takeProviderArtifactDrafts: vi.fn(() => []),
      commitKernelTurn,
      prepareProvider: vi.fn(async () => {
        order.push('prepare-provider');
        return prepared;
      }),
      processResponse,
      now: () => NOW + 4,
    });

    expect(result).toMatchObject({
      kind: 'committed',
      value: {
        response: processed,
        messageParts: [{ kind: 'text', text: 'Verified answer.' }],
      },
    });
    expect(commitKernelTurn).toHaveBeenCalledOnce();
    expect(commitKernelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: input.accountId,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        assistantMessage: expect.objectContaining({
          id: `msg_${input.attempt.requestId}` as MessageId,
          chat_id: input.chatId as ChatId,
          role: 'assistant',
        }),
      }),
    );
    expect(order).toEqual([
      'read-run',
      'authority-current',
      'transition-compiling',
      'transition-running',
      'register-abort',
      'prepare-provider',
      'resolve-provider',
      'authority-current',
      'provider-start',
      'record-provider-started',
      'process-response',
      'commit-turn',
      'record-provider-result',
      'provider-registration-dispose',
      'unregister-abort',
      'resolved-dispose',
      'prepared-dispose',
    ]);
    expect(input.workspaceId as WorkspaceId).toBe('workspace-kernel');
  });

  it('returns a host-only deferred voice result while retaining provider evidence until response readiness', async () => {
    const voiceRun = run({ source: 'voice' });
    const input = {
      ...turnInput({ run: voiceRun }),
      surface: 'voice' as const,
    };
    const harness = createKernelHarness(input, { persisted: voiceRun });

    const result = await runJarvisKernelVoiceTurn(input, harness.deps);

    expect(result).toMatchObject({
      kind: 'committed',
      value: {
        response: expect.objectContaining({ runId: voiceRun.id }),
        assistantMessage: expect.objectContaining({ chat_id: voiceRun.chatId }),
        artifacts: [],
        terminalStatus: 'completed',
      },
    });
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
    expect(harness.lifecycle.recordProviderResult).not.toHaveBeenCalled();
    expect(harness.providerRegistration.dispose).not.toHaveBeenCalled();
    expect(harness.cleanupCalls).toEqual(['abort', 'resolved', 'prepared']);

    if (result.kind !== 'committed') throw new Error('expected committed voice result');
    await expect(result.value.completeProviderEvidence()).resolves.toMatchObject({
      kind: 'committed',
    });
    result.value.dispose();
    result.value.dispose();

    expect(harness.lifecycle.recordProviderResult).toHaveBeenCalledOnce();
    expect(harness.providerRegistration.dispose).toHaveBeenCalledOnce();
  });

  it('rematerializes deferred voice artifacts with fresh private identities for one bounded retry', async () => {
    const voiceRun = run({ source: 'voice' });
    const input = {
      ...turnInput({ run: voiceRun }),
      surface: 'voice' as const,
    };
    const harness = createKernelHarness(input, { persisted: voiceRun });
    const draft: JarvisArtifactDraft = {
      artifact: {
        kind: 'provider_result',
        title: 'Retry-safe voice artifact',
        sourceRefs: [],
        createdAt: NOW + 4,
      },
      backing: { kind: 'producer_result', content: 'verified voice bytes' },
    };
    let identity = 0;
    const materialize = vi.fn(async (): Promise<JarvisArtifactV1> => {
      identity += 1;
      return Object.freeze({
        schemaVersion: 1,
        id: `jartifact_voice-retry-${identity}`,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: input.attempt.attemptNumber,
        state: 'ready',
        kind: 'provider_result',
        title: draft.artifact.title,
        sourceRefs: [],
        createdAt: NOW + 4,
        localReference: {
          kind: 'blob_key' as const,
          value: `jarvis-artifacts/voice-retry-${identity}`,
        },
      });
    });
    const result = await runJarvisKernelVoiceTurn(input, {
      ...harness.deps,
      takeProviderArtifactDrafts: vi.fn(() => [draft]),
      issueBoundArtifactPipeline: vi.fn(() => ({ provider: { materialize } }) as never),
    });

    if (result.kind !== 'committed') throw new Error('expected committed voice result');
    const rematerialized = await result.value.rematerializeForRetry();

    expect(result.value.artifacts.map((artifact) => artifact.id)).toEqual([
      'jartifact_voice-retry-1',
    ]);
    expect(rematerialized.artifacts.map((artifact) => artifact.id)).toEqual([
      'jartifact_voice-retry-2',
    ]);
    expect(rematerialized.response.artifactIds).toEqual(['jartifact_voice-retry-2']);
    expect(rematerialized.assistantMessage.parts).toContainEqual(
      expect.objectContaining({
        kind: 'jarvis_artifact_ref',
        artifact: expect.objectContaining({ id: 'jartifact_voice-retry-2' }),
      }),
    );
    expect(materialize).toHaveBeenCalledTimes(2);
    rematerialized.dispose();
  });

  it('rejects a user-created Jarvis slug collision before provider preparation', async () => {
    const input = turnInput({ agent: agent({ builtin: false }) });
    const prepareProvider = vi.fn();

    await expect(
      runJarvisKernelTurn(input, {
        journal: { allocateRun: vi.fn(), getRun: vi.fn(async () => input.run) },
        issueBoundLifecycle: vi.fn(() => ({
          revocationSignal: new AbortController().signal,
          assertCurrent: vi.fn(),
          transition: vi.fn(async () => ({ kind: 'account_authority_revoked' as const })),
          registerAbortOwner: vi.fn(),
          recordProviderStarted: vi.fn(),
          recordProviderResult: vi.fn(),
        })) as never,
        issueBoundArtifactPipeline: vi.fn(),
        artifactEffectClaims: { claim: vi.fn() },
        takeProviderArtifactDrafts: vi.fn(() => []),
        commitKernelTurn: vi.fn(),
        prepareProvider,
        processResponse: vi.fn(),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_protected_jarvis' });
    expect(prepareProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['workspace', run({ workspaceId: 'workspace-foreign' })],
    ['project', run({ projectId: 'project-foreign' })],
    ['source', run({ source: 'schedule' })],
    ['agent', run({ agentId: 'agent-foreign' })],
    ['identity', run({ identityVersion: 2 })],
    ['profile', run({ profileRevisionId: 'profile-revision-foreign' })],
    ['model', run({ model: { ...run().model, modelId: 'model-foreign' } })],
  ] as const)(
    'rejects a persisted %s binding mismatch before issuing lifecycle authority',
    async (_label, persisted) => {
      const input = turnInput();
      const harness = createKernelHarness(input, { persisted });

      await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
        'kernel_turn_persisted_run_mismatch',
      );
      expect(harness.issueBoundLifecycle).not.toHaveBeenCalled();
      expect(harness.lifecycle.transition).not.toHaveBeenCalled();
      expect(harness.deps.prepareProvider).not.toHaveBeenCalled();
    },
  );

  it('validates the request attempt before issuing lifecycle authority or transitioning', async () => {
    const input = turnInput({
      attempt: {
        kind: 'initial',
        requestId: '',
        runId: 'run-kernel-integration',
        attemptNumber: 1,
      },
    });
    const harness = createKernelHarness(input);

    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toMatchObject({
      code: 'invalid_request_attempt',
    });
    expect(harness.issueBoundLifecycle).not.toHaveBeenCalled();
    expect(harness.lifecycle.transition).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)(
    'maps authority revocation at currentness checkpoint %s without starting a provider',
    async (checkpoint) => {
      const input = turnInput();
      const harness = createKernelHarness(input, {
        onAssertCurrent(call, authority) {
          if (call === checkpoint) {
            authority.abort('account_changed');
            throw new Error('kernel_account_authority_revoked');
          }
        },
      });

      await expect(runJarvisKernelTurn(input, harness.deps)).resolves.toEqual({
        kind: 'account_authority_revoked',
      });
      if (checkpoint === 1) {
        expect(harness.lifecycle.transition).not.toHaveBeenCalled();
      }
      expect(harness.resolved.start).not.toHaveBeenCalled();
    },
  );

  it('does not translate a non-revocation currentness failure', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input, {
      onAssertCurrent() {
        throw new Error('currentness_verifier_failed');
      },
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
      'currentness_verifier_failed',
    );
  });

  it('maps authority revocation while awaiting the provider response and aborts the started dispatch', async () => {
    const input = turnInput();
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<Readonly<RawProviderResponse>>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const harness = createKernelHarness(input, { response });

    const pending = runJarvisKernelTurn(input, harness.deps);
    await vi.waitFor(() => expect(harness.resolved.start).toHaveBeenCalledOnce());
    harness.authority.abort('account_changed');
    rejectResponse(new Error('provider_aborted'));

    await expect(pending).resolves.toEqual({ kind: 'account_authority_revoked' });
    expect(harness.started.abortAfterStart).toHaveBeenCalledWith('authority_revoked');
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
  });

  it.each(['missing', 'mismatched'] as const)(
    'rejects %s committed provider source evidence before live completion',
    async (variant) => {
      const input = turnInput();
      const expected = providerResultSource(input);
      const committedEvent: JarvisEvent = {
        runId: input.run.id,
        seq: 3,
        idempotencyKey: 'kernel-terminal:request-kernel:1',
        type: 'run_state',
        status: 'completed',
        title: 'Kernel turn completed',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW + 4,
        ...(variant === 'missing'
          ? {}
          : {
              producerSourceEvidence: {
                ...expected,
                resultRef: 'jresult_forged',
              },
            }),
      };
      const harness = createKernelHarness(input, { committedEvent });

      await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
        'kernel_turn_commit_source_mismatch',
      );
      expect(harness.lifecycle.recordProviderResult).not.toHaveBeenCalled();
    },
  );

  it('materializes one bound provider artifact and uses the same identity in response, projection, and commit', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input);
    const draft: JarvisArtifactDraft = {
      artifact: {
        kind: 'provider_result',
        title: 'Verified provider result',
        sourceRefs: [],
        createdAt: NOW + 4,
      },
      backing: { kind: 'producer_result', content: 'verified bytes' },
    };
    const artifact: JarvisArtifactV1 = {
      schemaVersion: 1,
      id: 'jartifact_kernel-provider',
      runId: input.run.id,
      requestId: input.attempt.requestId,
      attemptNumber: input.attempt.attemptNumber,
      state: 'ready',
      kind: 'provider_result',
      title: 'Verified provider result',
      sourceRefs: [],
      createdAt: NOW + 4,
      contentHash: 'a'.repeat(64),
      sizeBytes: 14,
      preview: { kind: 'text', text: 'verified bytes', truncated: false, sizeBytes: 14 },
      localReference: { kind: 'blob_key', value: 'jarvis-artifacts/kernel-provider' },
    };
    const materialize = vi.fn(async () => artifact);
    const issueBoundArtifactPipeline = vi.fn(
      () =>
        ({
          provider: { materialize },
        }) as never,
    );
    const artifactEffectClaims = { claim: vi.fn() };
    const deps: JarvisKernelDeps = {
      ...harness.deps,
      issueBoundArtifactPipeline,
      artifactEffectClaims,
      takeProviderArtifactDrafts: vi.fn(() => [draft]),
    };

    const result = await runJarvisKernelTurn(input, deps);

    expect(result).toMatchObject({
      kind: 'committed',
      value: {
        response: { artifactIds: [artifact.id] },
        messageParts: [
          { kind: 'text', text: 'Verified answer.' },
          { kind: 'jarvis_artifact_ref', artifact: { id: artifact.id } },
        ],
      },
    });
    expect(issueBoundArtifactPipeline).toHaveBeenCalledWith(artifactEffectClaims);
    expect(materialize).toHaveBeenCalledWith({
      evidence: {
        producerId: 'provider_response',
        accountId: input.accountId,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: 1,
        resultRef: 'jresult_request-kernel',
        state: 'completed',
        verifiedAt: NOW + 4,
        providerId: PROVIDER_RECEIPT.providerId,
        modelId: PROVIDER_RECEIPT.modelId,
        modelSnapshotRef: PROVIDER_RECEIPT.modelSnapshotRef,
      },
      draft: expect.objectContaining({
        artifact: expect.objectContaining({ title: draft.artifact.title }),
        backing: expect.objectContaining({ kind: 'producer_result' }),
      }),
    });
    expect(harness.commitKernelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [artifact],
        terminal: expect.objectContaining({
          event: expect.objectContaining({ artifactIds: [artifact.id] }),
        }),
      }),
    );
  });

  it('detaches every sidecar draft before awaiting the first materialization', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input);
    const drafts = [
      {
        artifact: {
          kind: 'provider_result' as const,
          title: 'Original first',
          sourceRefs: [],
          createdAt: NOW + 4,
        },
        backing: { kind: 'producer_result' as const, content: new Uint8Array([1, 2, 3]) },
      },
      {
        artifact: {
          kind: 'provider_result' as const,
          title: 'Original second',
          sourceRefs: [],
          createdAt: NOW + 4,
        },
        backing: { kind: 'producer_result' as const, content: new Uint8Array([4, 5, 6]) },
      },
    ];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let materialization = 0;
    const materialize = vi.fn(async ({ draft }: { draft: JarvisArtifactDraft }) => {
      const index = materialization++;
      if (index === 0) await firstPending;
      return {
        schemaVersion: 1 as const,
        id: `jartifact_snapshot-${index}`,
        runId: input.run.id,
        requestId: input.attempt.requestId,
        attemptNumber: input.attempt.attemptNumber,
        state: 'ready' as const,
        kind: 'provider_result' as const,
        title: draft.artifact.title,
        sourceRefs: [],
        createdAt: NOW + 4,
        localReference: {
          kind: 'blob_key' as const,
          value: `jarvis-artifacts/snapshot-${index}`,
        },
      };
    });
    const deps: JarvisKernelDeps = {
      ...harness.deps,
      issueBoundArtifactPipeline: vi.fn(() => ({ provider: { materialize } }) as never),
      takeProviderArtifactDrafts: vi.fn(() => drafts),
    };

    const pending = runJarvisKernelTurn(input, deps);
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1));
    drafts[1]!.artifact.title = 'Mutated after first await';
    drafts[1]!.backing.content[0] = 99;
    releaseFirst();

    await expect(pending).resolves.toMatchObject({ kind: 'committed' });
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize.mock.calls[1]![0].draft.artifact.title).toBe('Original second');
    expect(
      (materialize.mock.calls[1]![0].draft.backing as { content: Uint8Array }).content[0],
    ).toBe(4);
  });

  it('rejects a missing provider artifact sidecar before projection or commit', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input);
    const deps: JarvisKernelDeps = {
      ...harness.deps,
      takeProviderArtifactDrafts: vi.fn(() => undefined),
    };

    await expect(runJarvisKernelTurn(input, deps)).rejects.toThrow(
      'kernel_provider_artifact_sidecar_missing',
    );
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
  });

  it('rejects processor-supplied artifact IDs before consuming the private sidecar', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input);
    const takeProviderArtifactDrafts = vi.fn(() => []);
    const deps: JarvisKernelDeps = {
      ...harness.deps,
      takeProviderArtifactDrafts,
      processResponse: vi.fn(async () => ({
        ...processedResponse(input),
        artifactIds: ['jartifact_forged'],
      })),
    };

    await expect(runJarvisKernelTurn(input, deps)).rejects.toThrow(
      'kernel_provider_response_scope_mismatch',
    );
    expect(takeProviderArtifactDrafts).not.toHaveBeenCalled();
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
  });

  it.each(['registration', 'abort', 'resolved', 'prepared'] as const)(
    'runs every cleanup exactly once when the %s disposer throws',
    async (failingCleanup) => {
      const input = turnInput();
      const harness = createKernelHarness(input, {
        cleanupThrows: new Set([failingCleanup]),
      });

      await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
        `cleanup_${failingCleanup}`,
      );
      expect(harness.cleanupCalls).toEqual(['registration', 'abort', 'resolved', 'prepared']);
      expect(harness.providerRegistration.dispose).toHaveBeenCalledOnce();
      expect(harness.resolved.dispose).toHaveBeenCalledOnce();
      expect(harness.prepared.dispose).toHaveBeenCalledOnce();
    },
  );

  it('retains public partial text atomically with a failed turn without success evidence', async () => {
    const input = turnInput();
    const failure = new Error('interrupted_provider');
    const harness = createKernelHarness(input, { response: Promise.reject(failure) });
    Object.assign(harness.started, { getPartialText: () => 'The answer began.' });
    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toBe(failure);
    expect(harness.commitKernelTurn).toHaveBeenCalledOnce();
    const commit = harness.commitKernelTurn.mock.calls[0]![0];
    expect(commit).toMatchObject({
      expectedStatus: 'running', terminal: { status: 'failed' }, artifacts: [],
      assistantMessage: { role: 'assistant', parts: [{ kind: 'text', text: 'The answer began.\n\n[Incomplete response: generation failed.]' }] },
    });
    expect(commit.terminal.event).not.toHaveProperty('canonicalResultEvidence');
    expect(commit.terminal.event).not.toHaveProperty('producerSourceEvidence');
    expect(harness.lifecycle.recordProviderResult).not.toHaveBeenCalled();
    expect(harness.deps.processResponse).not.toHaveBeenCalled();
  });

  it('retains reported usage and public tool parts on failure without prose or success authority', async () => {
    const input = turnInput();
    const failure = new Error('tool_failed');
    const harness = createKernelHarness(input, { response: Promise.reject(failure) });
    const usage = { provider: harness.started.receipt.providerId, model: harness.started.receipt.modelId,
      input_tokens: 17, output_tokens: 3, total_tokens: 23 };
    const parts = [{ kind: 'tool_call' as const, tool: 'read', args: {}, call_id: 'read-1' },
      { kind: 'tool_result' as const, call_id: 'read-1', error: 'Permission denied' }];
    Object.assign(harness.started, { getPartialUsage: () => usage, getPartialParts: () => parts });
    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toBe(failure);
    expect(harness.commitKernelTurn).toHaveBeenCalledOnce();
    const commit = harness.commitKernelTurn.mock.calls[0]![0];
    expect(commit.assistantMessage.usage).toEqual(usage);
    expect(commit.assistantMessage.parts).toEqual([...parts,
      { kind: 'text', text: '[Incomplete response: generation failed.]' }]);
    expect(commit.terminal.status).toBe('failed');
    expect(harness.lifecycle.recordProviderResult).not.toHaveBeenCalled();
    expect(harness.deps.processResponse).not.toHaveBeenCalled();
  });

  it('does not retain partial text when response processing fails after provider completion', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input);
    Object.assign(harness.started, { getPartialText: () => 'Unprocessed output.' });
    vi.mocked(harness.deps.processResponse).mockRejectedValueOnce(new Error('invalid_response'));
    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow('invalid_response');
    expect(harness.commitKernelTurn).not.toHaveBeenCalled();
  });

  it('preserves the primary provider failure while every cleanup still runs', async () => {
    const input = turnInput();
    const harness = createKernelHarness(input, {
      response: Promise.reject(new Error('primary_provider_failure')),
      cleanupThrows: new Set(['registration', 'abort', 'resolved', 'prepared']),
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
      'primary_provider_failure',
    );
    expect(harness.lifecycle.transition).toHaveBeenNthCalledWith(3, {
      expectedStatus: 'running',
      nextStatus: 'failed',
      event: {
        idempotencyKey: `kernel:${input.attempt.requestId}:failed`,
        title: 'Protected request failed',
        safeSummary: 'The protected provider request failed before canonical completion.',
        sourceRefs: [],
        artifactIds: [],
        createdAt: NOW + 4,
      },
      completedAt: NOW + 4,
    });
    expect(harness.cleanupCalls).toEqual(['registration', 'abort', 'resolved', 'prepared']);
  });

  it('observes early provider failures while start evidence is still being persisted', async () => {
    const input = turnInput();
    const failure = new Error('early_provider_failure');
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<Readonly<RawProviderResponse>>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const responseCatch = vi.spyOn(response, 'catch');
    const harness = createKernelHarness(input, { response });
    vi.mocked(harness.lifecycle.recordProviderStarted).mockImplementationOnce(async () => {
      expect(responseCatch).toHaveBeenCalledOnce();
      rejectResponse(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { kind: 'committed', value: harness.providerRegistration };
    });

    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toBe(failure);
    expect(harness.lifecycle.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ nextStatus: 'failed' }),
    );
    expect(harness.deps.processResponse).not.toHaveBeenCalled();
    expect(harness.cleanupCalls).toEqual(['registration', 'abort', 'resolved', 'prepared']);
  });

  it('terminalizes and tears down a started provider when start evidence registration fails', async () => {
    const input = turnInput();
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<Readonly<RawProviderResponse>>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const responseCatch = vi.spyOn(response, 'catch');
    const harness = createKernelHarness(input, { response });
    vi.mocked(harness.lifecycle.recordProviderStarted).mockRejectedValueOnce(
      new Error('provider_registration_failure'),
    );

    await expect(runJarvisKernelTurn(input, harness.deps)).rejects.toThrow(
      'provider_registration_failure',
    );
    expect(harness.lifecycle.transition).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ expectedStatus: 'running', nextStatus: 'failed' }),
    );
    expect(harness.started.abortAfterStart).toHaveBeenCalledWith('evidence_commit_failed');
    expect(responseCatch).toHaveBeenCalledOnce();
    expect(harness.cleanupCalls).toEqual(['abort', 'resolved', 'prepared']);

    rejectResponse(new Error('late_provider_rejection'));
    await Promise.resolve();
  });

  it('leaves scheduled provider failure terminalization to the retry settlement authority', async () => {
    const scheduledRun = run({ source: 'schedule', status: 'running' });
    const input = {
      ...turnInput({ run: scheduledRun, surface: 'schedule' }),
      run: scheduledRun,
      surface: 'schedule' as const,
    };
    const harness = createKernelHarness(input, {
      persisted: scheduledRun,
      response: Promise.reject(new Error('scheduled_provider_failure')),
    });

    await expect(runJarvisKernelScheduledTurn(input, harness.deps)).rejects.toThrow(
      'scheduled_provider_failure',
    );
    expect(harness.lifecycle.transition).not.toHaveBeenCalled();
    expect(harness.started.abortAfterStart).toHaveBeenCalledWith('evidence_commit_failed');
  });

  it('preserves a revoked authority result while every throwing cleanup still runs', async () => {
    const input = turnInput();
    let rejectResponse!: (reason: unknown) => void;
    const response = new Promise<Readonly<RawProviderResponse>>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const harness = createKernelHarness(input, {
      response,
      cleanupThrows: new Set(['registration', 'abort', 'resolved', 'prepared']),
    });

    const pending = runJarvisKernelTurn(input, harness.deps);
    await vi.waitFor(() => expect(harness.resolved.start).toHaveBeenCalledOnce());
    harness.authority.abort('account_changed');
    rejectResponse(new Error('provider_aborted'));

    await expect(pending).resolves.toEqual({ kind: 'account_authority_revoked' });
    expect(harness.cleanupCalls).toEqual(['registration', 'abort', 'resolved', 'prepared']);
  });
});
