import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent, ProviderRequest } from './types';
import type { ProviderLiveTurnControl } from './types';
import { CODEX_CONTEXT_TOOL } from './codexContextTool';
import {
  codexApprovalPolicyForRequest,
  createCodexPersistentAdapter,
  resolveCodexExecutable,
} from './codexPersistent';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';

const connection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-app-server',
  providerId: 'openai',
  displayName: 'Codex',
  mode: 'external-cli',
  authSource: 'codex-cli-session',
  promptTransport: 'native-system',
  enabled: true,
  capabilities: {
    text: true,
    images: false,
    files: true,
    tools: true,
    modelSelection: true,
    structuredOutput: true,
    streaming: true,
    cancellation: true,
    resumeSession: true,
    systemPrompt: true,
    workingDirectory: true,
    usage: true,
    subscriptionQuota: false,
    localOnly: false,
  },
};
const codexRoute = Object.freeze({
  kind: 'official-codex' as const,
  connectionId: 'openai-codex' as const,
  providerId: 'openai' as const,
  modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
});

async function* frames() {
  yield {
    id: 'request_1_model_1',
    result: {
      data: [
        {
          model: 'opencode-go/deepseek-v4-flash-vision-exp',
          supportedReasoningEfforts: [],
          serviceTiers: [],
        },
      ],
      nextCursor: null,
    },
  };
  yield {
    id: 'request_1_thread',
    result: {
      thread: { id: 'thread_native_1' },
      model: 'opencode-go/deepseek-v4-flash-vision-exp',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: 'C:\\workspace',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: null,
    },
  };
  yield {
    method: 'turn/started',
    params: {
      threadId: 'thread_native_1',
      turn: { id: 'turn_native_1' },
    },
  };
  yield {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      itemId: 'message_native_1',
      delta: 'Working on it.',
    },
  };
  yield {
    method: 'item/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      item: {
        id: 'command_native_1',
        type: 'commandExecution',
        status: 'completed',
        commandActions: [{ type: 'read', path: 'C:\\workspace\\game.js' }],
        exitCode: 0,
      },
    },
  };
  yield {
    method: 'turn/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    },
  };
}

async function* framesForAgentProfile(profile: 'full' | 'review') {
  for await (const frame of frames()) {
    if (frame.id !== 'request_1_thread') {
      yield frame;
      continue;
    }
    yield {
      ...frame,
      result: {
        ...frame.result,
        approvalPolicy: profile === 'full' ? 'never' : 'on-request',
        sandbox: profile === 'full'
          ? { type: 'dangerFullAccess' }
          : {
              type: 'workspaceWrite',
              writableRoots: ['C:\\workspace'],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
      },
    };
  }
}

function activeCancellationFixture(options?: {
  write?: (frame: Record<string, unknown>) => Promise<void> | void;
}) {
  const controller = new AbortController();
  const queuedFrames: Record<string, unknown>[] = [];
  let wakeFrame: ((frame: Record<string, unknown> | null) => void) | undefined;
  let ingressSignal: AbortSignal | undefined;
  let resolveControlPublished!: () => void;
  let resolveWrongResponseDelivered!: () => void;
  const controlPublished = new Promise<void>((resolve) => { resolveControlPublished = resolve; });
  const wrongResponseDelivered = new Promise<void>((resolve) => { resolveWrongResponseDelivered = resolve; });
  const writes: Record<string, unknown>[] = [];
  const events: ProviderEvent[] = [];
  const stop = vi.fn(async () => true);
  const pushFrame = (frame: Record<string, unknown>) => {
    const resume = wakeFrame;
    if (resume) {
      wakeFrame = undefined;
      resume(frame);
    } else queuedFrames.push(frame);
  };
  async function* activeFrames(signal?: AbortSignal) {
    ingressSignal = signal;
    for await (const frame of frames()) {
      yield frame;
      if (frame.method === 'item/agentMessage/delta') break;
    }
    while (true) {
      const frame = queuedFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
        const onAbort = () => {
          wakeFrame = undefined;
          resolve(null);
        };
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        wakeFrame = (next) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(next);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      if (!frame) return;
      yield frame;
      if (frame.id === 'wrong_interrupt_response') resolveWrongResponseDelivered();
    }
  }
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'cancel-ack-generation' }),
    frames: (_generation, signal) => ({ stream: activeFrames(signal), ready: Promise.resolve() }),
    write: async (_generation, frame) => {
      writes.push(frame);
      await options?.write?.(frame);
    },
    stop,
  });
  const running = (async () => {
    for await (const event of adapter.send!({
      requestId: 'request_1', connection, codexRoute, chatId: 'chat_cancel_ack',
      prompt: 'Read the marker', modelId: codexRoute.modelId,
      workingDirectory: 'C:\\workspace', interactionMode: 'ask', signal: controller.signal,
      onLiveTurnControl: (control) => { if (control) resolveControlPublished(); },
    })) {
      events.push(event);
    }
  })();
  const settled = running.then(
    () => ({ status: 'resolved' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  return { controller, running, settled, writes, events, stop, pushFrame, controlPublished, wrongResponseDelivered, get ingressAborted() {
    return ingressSignal?.aborted ?? false;
  } };
}

describe('persistent Codex app-server adapter', () => {
  it('discovers skills through native skills/list for the exact requested cwd and supports forced refresh', async () => {
    const writes: Record<string, unknown>[] = [];
    const stopped: string[] = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'skill-catalog-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-skill-catalog_list',
            result: { data: [{
              cwd: 'C:\\workspace\\game',
              skills: [{
                name: 'safe-fast-fix',
                description: 'Implement a focused fix.',
                path: 'C:\\Users\\viper\\.codex\\skills\\safe-fast-fix\\SKILL.md',
                scope: 'user', enabled: true, pluginId: null,
              }],
              errors: [],
            }] },
          };
        })(),
      }),
      write: async (_generation, frame) => { writes.push(frame); },
      stop: async (generation) => { stopped.push(generation); return true; },
    });

    await expect(adapter.listSkills({
      workingDirectory: 'C:\\workspace\\game',
      forceReload: true,
    })).resolves.toEqual([{
      cwd: 'C:\\workspace\\game',
      skills: [{
        cwd: 'C:\\workspace\\game',
        name: 'safe-fast-fix',
        description: 'Implement a focused fix.',
        path: 'C:\\Users\\viper\\.codex\\skills\\safe-fast-fix\\SKILL.md',
        scope: 'user', enabled: true, pluginId: null,
      }],
      errors: [],
    }]);
    expect(writes).toEqual([{
      id: 'vibespace-codex-skill-catalog_list',
      method: 'skills/list',
      params: { cwds: ['C:\\workspace\\game'], forceReload: true },
    }]);
    expect(stopped).toEqual(['skill-catalog-generation']);
  });

  it('rejects a stale selected skill before starting a native turn', async () => {
    const writes: Record<string, unknown>[] = [];
    const nativeSkill = {
      name: 'safe-fast-fix',
      description: 'Implement a focused fix.',
      path: 'C:\\Users\\viper\\.codex\\skills\\safe-fast-fix\\SKILL.md',
      scope: 'user' as const, enabled: true, pluginId: null,
    };
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'stale-skill-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          for await (const frame of framesForAgentProfile('full')) {
            yield frame;
            if (frame.id === 'request_1_thread') {
              yield {
                id: 'request_1_skills_1',
                result: { data: [{ cwd: 'C:\\workspace', skills: [nativeSkill], errors: [] }] },
              };
            }
          }
        })(),
      }),
      write: async (_generation, frame) => { writes.push(frame); },
      stop: async () => true,
    });

    await expect((async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1', connection, codexRoute,
        prompt: 'Use this skill.', modelId: codexRoute.modelId,
        workingDirectory: 'C:\\workspace',
        interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
        codexSkills: [{
          cwd: 'C:\\workspace', ...nativeSkill,
          path: 'C:\\stale\\SKILL.md',
        }],
      })) { /* consume */ }
    })()).rejects.toThrow(/missing, disabled, or duplicated/iu);
    expect(writes.some((frame) => frame.method === 'skills/list')).toBe(true);
    expect(writes.some((frame) => frame.method === 'turn/start')).toBe(false);
  });

  it('keeps the native generation alive through an auto-started queued turn and reconciles its reply once', async () => {
    const queuedFrames: Array<Record<string, unknown>> = [];
    let wakeFrame: ((frame: Record<string, unknown> | null) => void) | undefined;
    const pushFrame = (frame: Record<string, unknown>) => {
      if (wakeFrame) {
        const wake = wakeFrame;
        wakeFrame = undefined;
        wake(frame);
      } else queuedFrames.push(frame);
    };
    async function* firstGenerationFrames(signal?: AbortSignal) {
      for await (const frame of framesForAgentProfile('full')) {
        if (frame.method === 'item/agentMessage/delta') break;
        yield frame;
      }
      while (!signal?.aborted) {
        const frame = queuedFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          const onAbort = () => { wakeFrame = undefined; resolve(null); };
          if (signal?.aborted) { resolve(null); return; }
          wakeFrame = (next) => { signal?.removeEventListener('abort', onAbort); resolve(next); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!frame) return;
        yield frame;
      }
    }
    async function* secondGenerationFrames() {
      let count = 0;
      for await (const source of framesForAgentProfile('full')) {
        const frame = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        if (frame.id === 'request_1_model_1') frame.id = 'request_2_model_1';
        if (frame.id === 'request_1_thread') frame.id = 'request_2_resume';
        if (count++ < 2) yield frame;
        else break;
      }
      yield { id: 'request_2_queue_list_0', result: { data: [], nextCursor: null } };
      yield { id: 'request_2_queue_read', result: { thread: {
        id: 'thread_native_1', status: { type: 'idle' }, turns: [{
          id: 'turn_queued_2', status: 'completed', itemsView: 'full', items: [
            { type: 'userMessage', id: 'user_queued_2', clientId: 'message_queue_1', content: [] },
            { type: 'agentMessage', id: 'answer_queued_2', phase: 'final_answer', text: 'Queued result.' },
          ],
        }],
      } } };
    }
    const writes: Array<{ generation: string; frame: Record<string, unknown> }> = [];
    const stopped: string[] = [];
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: stopped.length === 0 && writes.length === 0
        ? 'codex-generation-predecessor' : 'codex-generation-reconcile' }),
      frames: (generation, signal) => ({
        stream: generation === 'codex-generation-predecessor'
          ? firstGenerationFrames(signal) : secondGenerationFrames(),
        ready: Promise.resolve(),
      }),
      write: async (generation, frame) => {
        writes.push({ generation, frame });
        if (frame.method === 'thread/queue/add') {
          const params = frame.params as { clientUserMessageId: string; input: unknown[] };
          pushFrame({ id: frame.id, result: { queuedSubmission: {
            id: 'submission_native_1', clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          } } });
        } else if (generation === 'codex-generation-predecessor' && frame.method === 'thread/queue/list') {
          pushFrame({ id: frame.id, result: { data: [], nextCursor: null } });
        } else if (generation === 'codex-generation-predecessor' && frame.method === 'thread/read') {
          pushFrame({ id: frame.id, result: { thread: {
            id: 'thread_native_1', status: { type: 'idle' }, turns: [{
              id: 'turn_queued_2', status: 'completed', itemsView: 'full', items: [
                { type: 'userMessage', id: 'user_queued_2', clientId: 'message_queue_1', content: [] },
                { type: 'agentMessage', id: 'answer_queued_2', phase: 'final_answer', text: 'Queued result.' },
              ],
            }],
          } } });
        }
      },
      stop: async (generation) => { stopped.push(generation); return true; },
    });
    let publishControl!: (control: ProviderLiveTurnControl) => void;
    const controlPublished = new Promise<ProviderLiveTurnControl>((resolve) => { publishControl = resolve; });
    const predecessorEvents: ProviderEvent[] = [];
    const predecessor = (async () => {
      for await (const event of adapter.send!({
        requestId: 'request_1', connection, codexRoute, chatId: 'chat-queued',
        prompt: 'Original request', modelId: codexRoute.modelId,
        interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
        onLiveTurnControl: (control) => { if (control) publishControl(control); },
      })) predecessorEvents.push(event);
    })();
    const control = await controlPublished;
    await expect(control.enqueue({
      clientUserMessageId: 'message_queue_1', text: 'Do this next.',
    })).resolves.toEqual({
      submissionId: 'submission_native_1', threadId: 'thread_native_1', turnId: 'turn_native_1',
    });
    pushFrame({ method: 'turn/completed', params: {
      threadId: 'thread_native_1', turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stoppedBeforeQueuedTerminal = [...stopped];
    pushFrame({ method: 'turn/started', params: {
      threadId: 'thread_native_1', turn: { id: 'turn_queued_2' },
    } });
    pushFrame({ method: 'turn/completed', params: {
      threadId: 'thread_native_1', turnId: 'turn_queued_2',
      turn: { id: 'turn_queued_2', status: 'completed' },
    } });
    await predecessor;
    expect(stoppedBeforeQueuedTerminal).toEqual([]);
    expect(stopped).toEqual(['codex-generation-predecessor']);
    expect(predecessorEvents).toContainEqual({ type: 'done', finishReason: 'completed' });

    const followupEvents: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_2', connection, codexRoute, chatId: 'chat-queued',
      prompt: 'Do this next.', modelId: codexRoute.modelId,
      sessionId: 'thread_native_1', expectedSessionId: 'thread_native_1',
      interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
      nativeQueuedSubmission: {
        submissionId: 'submission_native_1', clientUserMessageId: 'message_queue_1',
        threadId: 'thread_native_1', addedDuringTurnId: 'turn_native_1',
        previousTurnCompleted: true,
      },
    })) followupEvents.push(event);
    const followupWrites = writes.filter(({ generation }) => generation === 'codex-generation-reconcile');
    expect(followupWrites.filter(({ frame }) => frame.method === 'thread/queue/start')).toHaveLength(0);
    expect(followupWrites.filter(({ frame }) => frame.method === 'turn/start')).toHaveLength(0);
    expect(followupEvents.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'Queued result.' },
    ]);
    expect(followupEvents).toContainEqual({ type: 'done', finishReason: 'completed' });
  });

  function activeNativeQueueFixture() {
    const pendingFrames: Array<Record<string, unknown>> = [];
    let wakeFrame: ((frame: Record<string, unknown> | null) => void) | undefined;
    const pushFrame = (frame: Record<string, unknown>) => {
      if (wakeFrame) {
        const wake = wakeFrame;
        wakeFrame = undefined;
        wake(frame);
      } else pendingFrames.push(frame);
    };
    async function* stream(signal?: AbortSignal) {
      for await (const frame of framesForAgentProfile('full')) {
        if (frame.method === 'item/agentMessage/delta') break;
        yield frame;
      }
      while (!signal?.aborted) {
        const frame = pendingFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          const onAbort = () => { wakeFrame = undefined; resolve(null); };
          if (signal?.aborted) { resolve(null); return; }
          wakeFrame = (next) => { signal?.removeEventListener('abort', onAbort); resolve(next); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!frame) return;
        yield frame;
      }
    }
    const writes: Array<Record<string, unknown>> = [];
    const executeTool = vi.fn(async () => ({
      success: true, contentItems: [{ type: 'inputText' as const, text: 'result' }],
    }));
    const onApprovalRequested = vi.fn(async () => {});
    const stop = vi.fn(async () => true);
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => ({
        dynamicTools: [CODEX_CONTEXT_TOOL], bind: vi.fn(), executeTool,
        execute: executeTool, dispose: vi.fn(),
      }),
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-queue-authority' }),
      frames: (_generation, signal) => ({ stream: stream(signal), ready: Promise.resolve() }),
      write: async (_generation, frame) => {
        writes.push(frame);
        if (frame.method === 'thread/queue/add') {
          const params = frame.params as { clientUserMessageId: string; input: unknown[] };
          pushFrame({ id: frame.id, result: { queuedSubmission: {
            id: 'submission_native_1', clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          } } });
        } else if (frame.method === 'thread/queue/list') {
          pushFrame({ id: frame.id, result: { data: [], nextCursor: null } });
        } else if (frame.method === 'thread/read') {
          pushFrame({ id: frame.id, result: { thread: {
            id: 'thread_native_1', status: { type: 'idle' }, turns: [{
              id: 'turn_queued_2', status: 'completed', itemsView: 'full', items: [
                { type: 'userMessage', id: 'queued_user', clientId: 'message_queue_1', content: [] },
                { type: 'agentMessage', id: 'queued_answer', phase: 'final_answer', text: 'Queued result.' },
              ],
            }],
          } } });
        }
      },
      stop,
    });
    let publishControl!: (control: ProviderLiveTurnControl) => void;
    const controlPublished = new Promise<ProviderLiveTurnControl>((resolve) => { publishControl = resolve; });
    const running = (async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1', connection, codexRoute, chatId: 'chat-queue-authority',
        prompt: 'Original request', modelId: codexRoute.modelId,
        interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
        onApprovalRequested,
        onLiveTurnControl: (control) => { if (control) publishControl(control); },
      })) { /* keep reading native frames */ }
    })();
    return { pushFrame, writes, executeTool, onApprovalRequested, stop, controlPublished, running };
  }

  it.each(['dynamic tool', 'approval'] as const)(
    'does not execute a queued turn %s under predecessor authority', async (controlKind) => {
      const fixture = activeNativeQueueFixture();
      const control = await fixture.controlPublished;
      await control.enqueue({ clientUserMessageId: 'message_queue_1', text: 'Do this next.' });
      fixture.pushFrame({ method: 'turn/completed', params: {
        threadId: 'thread_native_1', turnId: 'turn_native_1',
        turn: { id: 'turn_native_1', status: 'completed' },
      } });
      fixture.pushFrame({ method: 'turn/started', params: {
        threadId: 'thread_native_1', turn: { id: 'turn_queued_2' },
      } });
      const dangerousId = controlKind === 'dynamic tool' ? 'queued_tool_call' : 'queued_approval';
      fixture.pushFrame(controlKind === 'dynamic tool'
        ? { id: dangerousId, method: 'item/tool/call', params: {
            threadId: 'thread_native_1', turnId: 'turn_queued_2',
            tool: CODEX_CONTEXT_TOOL.name, callId: dangerousId,
            arguments: { operation: 'describe' },
          } }
        : { id: dangerousId, method: 'item/commandExecution/requestApproval', params: {
            threadId: 'thread_native_1', turnId: 'turn_queued_2',
            itemId: 'queued_command', command: 'fixture-command',
          } });
      await expect(fixture.running).rejects.toThrow(/queued.*review before execution/u);
      expect(fixture.executeTool).not.toHaveBeenCalled();
      expect(fixture.onApprovalRequested).not.toHaveBeenCalled();
      expect(fixture.writes.some((frame) => frame.id === dangerousId)).toBe(false);
      expect(fixture.stop).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a second native queue request before another queue/add write', async () => {
    const fixture = activeNativeQueueFixture();
    const control = await fixture.controlPublished;
    await expect(control.enqueue({
      clientUserMessageId: 'message_queue_1', text: 'Do this next.',
    })).resolves.toMatchObject({ submissionId: 'submission_native_1' });
    await expect(control.enqueue({
      clientUserMessageId: 'message_queue_2', text: 'Another queued task.',
    })).rejects.toThrow(/already has an accepted queued follow-up/u);
    expect(fixture.writes.filter((frame) => frame.method === 'thread/queue/add')).toHaveLength(1);
    fixture.pushFrame({ method: 'turn/completed', params: {
      threadId: 'thread_native_1', turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    } });
    fixture.pushFrame({ method: 'turn/started', params: {
      threadId: 'thread_native_1', turn: { id: 'turn_queued_2' },
    } });
    fixture.pushFrame({ method: 'turn/completed', params: {
      threadId: 'thread_native_1', turnId: 'turn_queued_2',
      turn: { id: 'turn_queued_2', status: 'completed' },
    } });
    await fixture.running;
    expect(fixture.writes.filter((frame) => frame.method === 'thread/queue/add')).toHaveLength(1);
  });

  it('reconciles an auto-dispatched native queue item without starting it again', async () => {
    const writes: Array<Record<string, unknown>> = [];
    let streamSignal: AbortSignal | undefined;
    async function* queuedTurnFrames() {
      let count = 0;
      for await (const source of frames()) {
        const frame = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        if (frame.id === 'request_1_thread') frame.id = 'request_1_resume';
        if (count++ < 2) yield frame;
        else break;
      }
      yield { id: 'request_1_queue_list_0', result: { data: [], nextCursor: null } };
      yield { id: 'request_1_queue_read', result: { thread: {
        id: 'thread_native_1', status: { type: 'idle' }, turns: [{
          id: 'turn_queued_2', status: 'completed', itemsView: 'full', items: [
            { type: 'userMessage', id: 'user_queued_2', clientId: 'message_queue_1', content: [] },
            { type: 'agentMessage', id: 'answer_queued_2', phase: 'final_answer', text: 'Queued result.' },
          ],
        }],
      } } };
    }
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-queued' }),
      frames: (_generation, signal) => {
        streamSignal = signal;
        return { stream: queuedTurnFrames(), ready: Promise.resolve() };
      },
      write: async (_generation, message) => { writes.push(message); },
      stop: async () => true,
    });
    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1', connection, codexRoute, chatId: 'chat-queued',
      prompt: 'Do this next.', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      sessionId: 'thread_native_1', expectedSessionId: 'thread_native_1',
      interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
      nativeQueuedSubmission: {
        submissionId: 'submission_native_1', clientUserMessageId: 'message_queue_1',
        threadId: 'thread_native_1', addedDuringTurnId: 'turn_native_1',
        previousTurnCompleted: true,
      },
    })) events.push(event);
    expect(writes.filter(frame => frame.method === 'thread/queue/start')).toHaveLength(0);
    expect(writes.filter(frame => frame.method === 'thread/queue/list')).toHaveLength(1);
    expect(writes.filter(frame => frame.method === 'thread/read')).toHaveLength(1);
    expect(writes.filter(frame => frame.method === 'turn/start')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'text', delta: 'Queued result.' });
    expect(events).toContainEqual({ type: 'done', finishReason: 'completed' });
    expect(streamSignal?.aborted).toBe(true);
  });

  it('starts only the exact still-pending native queue item on an idle resumed thread', async () => {
    const writes: Array<Record<string, unknown>> = [];
    async function* pendingTurnFrames() {
      let count = 0;
      for await (const source of frames()) {
        const frame = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        if (frame.id === 'request_1_thread') frame.id = 'request_1_resume';
        if (count++ < 2) yield frame;
        else break;
      }
      yield { id: 'request_1_queue_list_0', result: { data: [{
        id: 'submission_native_1', clientUserMessageId: 'message_queue_1', input: [],
      }], nextCursor: null } };
      yield { id: 'request_1_queue_read', result: { thread: {
        id: 'thread_native_1', status: { type: 'idle' }, turns: [],
      } } };
      yield { id: 'request_1_queue', result: { turn: { id: 'turn_native_1', status: 'inProgress' } } };
      for await (const source of frames()) {
        if (source.method) yield source;
      }
    }
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-pending' }),
      frames: () => ({ stream: pendingTurnFrames(), ready: Promise.resolve() }),
      write: async (_generation, message) => { writes.push(message); },
      stop: async () => true,
    });
    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1', connection, codexRoute, chatId: 'chat-queued',
      prompt: 'Do this next.', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      sessionId: 'thread_native_1', expectedSessionId: 'thread_native_1',
      interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
      nativeQueuedSubmission: {
        submissionId: 'submission_native_1', clientUserMessageId: 'message_queue_1',
        threadId: 'thread_native_1', addedDuringTurnId: 'turn_native_1',
        previousTurnCompleted: true,
      },
    })) events.push(event);
    expect(writes.filter(frame => frame.method === 'thread/queue/start')).toHaveLength(1);
    expect(writes.filter(frame => frame.method === 'turn/start')).toHaveLength(0);
    expect(events).toContainEqual({ type: 'done', finishReason: 'completed' });
  });

  it('recovers the full final answer after observing an already-running queued turn', async () => {
    const writes: Array<Record<string, unknown>> = [];
    async function* runningTurnFrames() {
      let count = 0;
      for await (const source of frames()) {
        const frame = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
        if (frame.id === 'request_1_thread') frame.id = 'request_1_resume';
        if (count++ < 2) yield frame;
        else break;
      }
      yield { id: 'request_1_queue_list_0', result: { data: [], nextCursor: null } };
      yield { id: 'request_1_queue_read', result: { thread: {
        id: 'thread_native_1', status: { type: 'active' }, turns: [{
          id: 'turn_native_1', status: 'inProgress', itemsView: 'full', items: [
            { type: 'userMessage', id: 'user_queued_2', clientId: 'message_queue_1', content: [] },
          ],
        }],
      } } };
      yield { method: 'item/agentMessage/delta', params: {
        threadId: 'thread_native_1', turnId: 'turn_native_1', itemId: 'answer_queued_2',
        delta: 'Partial text that must be replaced.',
      } };
      yield { method: 'turn/completed', params: {
        threadId: 'thread_native_1', turnId: 'turn_native_1',
        turn: { id: 'turn_native_1', status: 'completed' },
      } };
      yield { id: 'request_1_queue_final_read', result: { thread: {
        id: 'thread_native_1', status: { type: 'idle' }, turns: [{
          id: 'turn_native_1', status: 'completed', itemsView: 'full', items: [
            { type: 'userMessage', id: 'user_queued_2', clientId: 'message_queue_1', content: [] },
            { type: 'agentMessage', id: 'answer_queued_2', phase: 'final_answer', text: 'Complete queued result.' },
          ],
        }],
      } } };
    }
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-running' }),
      frames: () => ({ stream: runningTurnFrames(), ready: Promise.resolve() }),
      write: async (_generation, message) => { writes.push(message); },
      stop: async () => true,
    });
    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1', connection, codexRoute, chatId: 'chat-queued',
      prompt: 'Do this next.', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      sessionId: 'thread_native_1', expectedSessionId: 'thread_native_1',
      interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
      nativeQueuedSubmission: {
        submissionId: 'submission_native_1', clientUserMessageId: 'message_queue_1',
        threadId: 'thread_native_1', addedDuringTurnId: 'turn_prior',
        previousTurnCompleted: true,
      },
    })) events.push(event);
    expect(writes.filter(frame => frame.method === 'thread/queue/start')).toHaveLength(0);
    expect(events.filter(event => event.type === 'text')).toEqual([
      { type: 'text', delta: 'Complete queued result.' },
    ]);
    expect(events).toContainEqual({ type: 'done', finishReason: 'completed' });
  });

  it('never starts a native queue item after the preceding turn failed', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-failed-queue' }),
      frames: () => ({ stream: (async function* () {
        for await (const source of frames()) {
          const frame = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
          if (frame.id === 'request_1_thread') frame.id = 'request_1_resume';
          yield frame;
        }
      })(), ready: Promise.resolve() }),
      write: async (_generation, message) => { writes.push(message); },
      stop: async () => true,
    });
    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1', connection, codexRoute, chatId: 'chat-queued',
        prompt: 'Do this next.', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        sessionId: 'thread_native_1', expectedSessionId: 'thread_native_1',
        interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
        nativeQueuedSubmission: {
          submissionId: 'submission_native_1', clientUserMessageId: 'message_queue_1',
          threadId: 'thread_native_1', addedDuringTurnId: 'turn_native_1',
          previousTurnCompleted: false,
        },
      })) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow('completed turn');
    expect(writes.map(frame => frame.method)).not.toContain('thread/queue/start');
    expect(writes.map(frame => frame.method)).not.toContain('turn/start');
  });

  it('uses native same-turn steer and provider queue add without interrupting or restarting the turn', async () => {
    const queuedFrames: Array<Record<string, unknown>> = [];
    let wakeFrame: ((frame: Record<string, unknown>) => void) | undefined;
    const pushFrame = (frame: Record<string, unknown>) => {
      if (wakeFrame) {
        const wake = wakeFrame;
        wakeFrame = undefined;
        wake(frame);
      } else queuedFrames.push(frame);
    };
    async function* activeTurnFrames(signal?: AbortSignal) {
      for await (const frame of framesForAgentProfile('full')) {
        if (frame.method === 'item/agentMessage/delta') break;
        yield frame;
      }
      while (true) {
        const frame = queuedFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          const onAbort = () => { wakeFrame = undefined; resolve(null); };
          if (signal?.aborted) { resolve(null); return; }
          wakeFrame = (next) => { signal?.removeEventListener('abort', onAbort); resolve(next); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!frame) return;
        yield frame;
      }
    }
    const controlRef: { current: ProviderLiveTurnControl | null } = { current: null };
    const discoveredSkill = {
      cwd: 'C:\\workspace',
      name: 'safe-fast-fix',
      description: 'Implement a focused fix.',
      path: 'C:\\Users\\viper\\.codex\\skills\\safe-fast-fix\\SKILL.md',
      scope: 'user' as const,
      enabled: true,
      pluginId: null,
    };
    let publishControl!: (control: ProviderLiveTurnControl) => void;
    const controlPublished = new Promise<ProviderLiveTurnControl>((resolve) => { publishControl = resolve; });
    let resolveSkillsChanged!: () => void;
    const skillsChanged = new Promise<void>((resolve) => { resolveSkillsChanged = resolve; });
    const writes: Array<Record<string, unknown>> = [];
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-controls' }),
      frames: (_generation, signal) => ({ stream: activeTurnFrames(signal), ready: Promise.resolve() }),
      write: async (_generation, message) => {
        writes.push(message);
        if (message.method === 'skills/list') {
          const params = message.params as { cwds: string[] };
          pushFrame({
            id: message.id,
            result: { data: [{ cwd: params.cwds[0], skills: [discoveredSkill], errors: [] }] },
          });
        } else if (message.method === 'turn/steer') {
          pushFrame({ id: message.id, result: { turnId: 'turn_native_1' } });
        } else if (message.method === 'thread/queue/add') {
          const params = message.params as { clientUserMessageId: string; input: unknown[] };
          pushFrame({ id: message.id, result: { queuedSubmission: {
            id: 'submission_native_1', clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          } } });
        } else if (message.method === 'thread/queue/list') {
          pushFrame({ id: message.id, result: { data: [], nextCursor: null } });
        } else if (message.method === 'thread/read') {
          pushFrame({ id: message.id, result: { thread: {
            id: 'thread_native_1', status: { type: 'idle' }, turns: [{
              id: 'turn_queued_2', status: 'completed', itemsView: 'full', items: [
                { type: 'userMessage', id: 'queued_user', clientId: 'message_queue_1', content: [] },
                { type: 'agentMessage', id: 'queued_answer', phase: 'final_answer', text: 'Queued result.' },
              ],
            }],
          } } });
        }
      },
      stop: async () => true,
    });
    const running = (async () => {
      const request: ProviderRequest = {
      requestId: 'request_1', connection, codexRoute, chatId: 'chat-controls',
      prompt: 'Original request', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full', approveAllForRun: false,
      codexSkills: [discoveredSkill],
      onCodexSkillsChanged: resolveSkillsChanged,
      onLiveTurnControl: (control: ProviderLiveTurnControl | null) => {
        controlRef.current = control;
        if (control) publishControl(control);
      },
      };
      for await (const _event of adapter.send!(request)) { /* keep the provider frame reader advancing while controls await replies */ }
    })();
    const activeControl = await controlPublished;
    pushFrame({ method: 'skills/changed', params: {} });
    await skillsChanged;
    await (activeControl.steer as (input: {
      clientUserMessageId: string;
      text: string;
      skills: readonly typeof discoveredSkill[];
    }) => Promise<void>)({
      clientUserMessageId: 'message_steer_1', text: 'Refine the same task.', skills: [discoveredSkill],
    });
    await expect((activeControl.enqueue as (input: {
      clientUserMessageId: string;
      text: string;
      skills: readonly typeof discoveredSkill[];
    }) => ReturnType<ProviderLiveTurnControl['enqueue']>)({
      clientUserMessageId: 'message_queue_1', text: 'Do this next.', skills: [discoveredSkill],
    })).resolves.toEqual({
      submissionId: 'submission_native_1',
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
    });
    expect(writes.map((message) => message.method)).toContain('turn/steer');
    expect(writes.map((message) => message.method)).toContain('thread/queue/add');
    expect(writes.filter((message) => message.method === 'skills/list')).toHaveLength(4);
    expect((writes.find((message) => message.method === 'turn/start')?.params as { input: unknown[] }).input).toContainEqual({
      type: 'skill', name: 'safe-fast-fix', path: discoveredSkill.path,
    });
    expect((writes.find((message) => message.method === 'turn/steer')?.params as { input: unknown[] }).input).toContainEqual({
      type: 'skill', name: 'safe-fast-fix', path: discoveredSkill.path,
    });
    expect((writes.find((message) => message.method === 'thread/queue/add')?.params as { input: unknown[] }).input).toContainEqual({
      type: 'skill', name: 'safe-fast-fix', path: discoveredSkill.path,
    });
    expect(writes.map((message) => message.method)).not.toContain('turn/interrupt');
    expect(writes.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    pushFrame({
      method: 'turn/completed',
      params: { threadId: 'thread_native_1', turnId: 'turn_native_1', turn: { id: 'turn_native_1', status: 'completed' } },
    });
    pushFrame({ method: 'turn/started', params: {
      threadId: 'thread_native_1', turn: { id: 'turn_queued_2' },
    } });
    pushFrame({ method: 'turn/completed', params: {
      threadId: 'thread_native_1', turnId: 'turn_queued_2', turn: { id: 'turn_queued_2', status: 'completed' },
    } });
    await running;
    expect(controlRef.current).toBeNull();
  });

  it('routes steer and queue acknowledgements while a context tool is still running', async () => {
    const queuedFrames: Array<Record<string, unknown>> = [];
    let wakeFrame: ((frame: Record<string, unknown>) => void) | undefined;
    const pushFrame = (frame: Record<string, unknown>) => {
      if (wakeFrame) {
        const wake = wakeFrame;
        wakeFrame = undefined;
        wake(frame);
      } else queuedFrames.push(frame);
    };
    async function* activeTurnFrames(signal?: AbortSignal) {
      for await (const frame of framesForAgentProfile('full')) {
        if (frame.method === 'item/agentMessage/delta') break;
        yield frame;
      }
      while (true) {
        const frame = queuedFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          const onAbort = () => { wakeFrame = undefined; resolve(null); };
          if (signal?.aborted) { resolve(null); return; }
          wakeFrame = (next) => { signal?.removeEventListener('abort', onAbort); resolve(next); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!frame) return;
        yield frame;
      }
    }
    let publishControl!: (control: ProviderLiveTurnControl) => void;
    const controlPublished = new Promise<ProviderLiveTurnControl>((resolve) => { publishControl = resolve; });
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    let toolFinished = false;
    let stage = 'control publication';
    const writes: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => ({
        dynamicTools: [CODEX_CONTEXT_TOOL],
        bind: vi.fn(),
        execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'done' }] })),
        executeTool: vi.fn(async () => {
          markToolStarted();
          await toolGate;
          toolFinished = true;
          return { success: true, contentItems: [{ type: 'inputText' as const, text: 'done' }] };
        }),
        dispose: vi.fn(),
      }),
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-frame-demux' }),
      frames: (_generation, signal) => ({ stream: activeTurnFrames(signal), ready: Promise.resolve() }),
      write: async (_generation, message) => {
        writes.push(message);
        if (message.method === 'turn/steer') {
          pushFrame({ id: message.id, result: { turnId: 'turn_native_1' } });
        } else if (message.method === 'thread/queue/add') {
          const params = message.params as { clientUserMessageId: string; input: unknown[] };
          pushFrame({ id: message.id, result: { queuedSubmission: {
            id: 'submission_native_1', clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          } } });
        } else if (message.method === 'thread/queue/list') {
          pushFrame({ id: message.id, result: { data: [], nextCursor: null } });
        } else if (message.method === 'thread/read') {
          pushFrame({ id: message.id, result: { thread: {
            id: 'thread_native_1', status: { type: 'idle' }, turns: [{
              id: 'turn_queued_demux', status: 'completed', itemsView: 'full', items: [
                { type: 'userMessage', id: 'queued_user', clientId: 'message_queue_demux', content: [] },
                { type: 'agentMessage', id: 'queued_answer', phase: 'final_answer', text: 'Queued result.' },
              ],
            }],
          } } });
        }
      },
      stop: async () => true,
    });
    const running = (async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1', connection, codexRoute, chatId: 'chat-frame-demux',
        prompt: 'Original request', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full', approveAllForRun: false,
        signal: controller.signal,
        onLiveTurnControl: (control) => { if (control) publishControl(control); },
      })) { /* keep event delivery running except while the adapter awaits its tool result */ }
    })();

    try {
      const withTimeout = <T>(promise: Promise<T>, stage: string) => Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`stage timeout: ${stage}`)), 1_000)),
      ]);
      const control = await withTimeout(controlPublished, 'control publication');
      stage = 'tool start';
      pushFrame({
        id: 'tool_call_demux', method: 'item/tool/call',
        params: {
          threadId: 'thread_native_1', turnId: 'turn_native_1', tool: 'vibespace_context',
          callId: 'tool_call_demux', arguments: { operation: 'describe' },
        },
      });
      await withTimeout(toolStarted, 'tool start');
      stage = 'control acknowledgements';
      const controlResults = Promise.all([
        control.steer({ clientUserMessageId: 'message_steer_demux', text: 'Continue this task.' }),
        control.enqueue({ clientUserMessageId: 'message_queue_demux', text: 'Do this next.' }),
      ]);
      const acceptedWhileToolBlocked = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 500);
        void controlResults.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
      });
      expect(acceptedWhileToolBlocked).toBe(true);
      stage = 'tool release';
      expect(toolFinished).toBe(false);
      expect(writes.map((message) => message.method)).toContain('turn/steer');
      expect(writes.map((message) => message.method)).toContain('thread/queue/add');
      expect(writes.map((message) => message.method)).not.toContain('turn/interrupt');
      expect(writes.filter((message) => message.method === 'turn/start')).toHaveLength(1);

      releaseTool();
      pushFrame({
        method: 'turn/completed',
        params: { threadId: 'thread_native_1', turnId: 'turn_native_1', turn: { id: 'turn_native_1', status: 'completed' } },
      });
      pushFrame({ method: 'turn/started', params: {
        threadId: 'thread_native_1', turn: { id: 'turn_queued_demux' },
      } });
      pushFrame({ method: 'turn/completed', params: {
        threadId: 'thread_native_1', turnId: 'turn_queued_demux',
        turn: { id: 'turn_queued_demux', status: 'completed' },
      } });
      await withTimeout(running, 'turn terminal');
      stage = 'complete';
    } finally {
      releaseTool();
      controller.abort();
      if (wakeFrame) pushFrame({ method: 'turn/completed', params: { threadId: 'thread_native_1', turnId: 'turn_native_1' } });
      if (stage === 'complete') await running;
    }
  });

  it('marks an unanswered native steer indeterminate and ignores a late response', async () => {
    vi.useFakeTimers();
    const queuedFrames: Array<Record<string, unknown>> = [];
    let wakeFrame: ((frame: Record<string, unknown>) => void) | undefined;
    let lateResponseId: string | undefined;
    let resolveLateResponseRead!: () => void;
    const lateResponseRead = new Promise<void>((resolve) => { resolveLateResponseRead = resolve; });
    const pushFrame = (frame: Record<string, unknown>) => {
      if (wakeFrame) {
        const wake = wakeFrame;
        wakeFrame = undefined;
        wake(frame);
      } else queuedFrames.push(frame);
    };
    async function* activeTurnFrames(signal?: AbortSignal) {
      for await (const frame of framesForAgentProfile('full')) {
        if (frame.method === 'item/agentMessage/delta') break;
        yield frame;
      }
      while (true) {
        const frame = queuedFrames.shift() ?? await new Promise<Record<string, unknown> | null>((resolve) => {
          const onAbort = () => { wakeFrame = undefined; resolve(null); };
          if (signal?.aborted) { resolve(null); return; }
          wakeFrame = (next) => { signal?.removeEventListener('abort', onAbort); resolve(next); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        if (!frame) return;
        if (frame.id === lateResponseId) resolveLateResponseRead();
        yield frame;
      }
    }
    let publishControl!: (control: ProviderLiveTurnControl) => void;
    const controlPublished = new Promise<ProviderLiveTurnControl>((resolve) => { publishControl = resolve; });
    const writes: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const adapter = createCodexPersistentAdapter({
      contextTool: async () => null,
      workingDirectory: async () => 'C:\\workspace',
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-steer-timeout' }),
      frames: (_generation, signal) => ({ stream: activeTurnFrames(signal), ready: Promise.resolve() }),
      write: async (_generation, message) => {
        writes.push(message);
        if (message.method === 'turn/interrupt') pushFrame({ id: message.id, result: {} });
      },
      stop: async () => true,
    });
    const running = (async () => {
      try {
        for await (const _event of adapter.send!({
          requestId: 'request_1', connection, codexRoute, chatId: 'chat-steer-timeout',
          prompt: 'Original request', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full', approveAllForRun: false,
          signal: controller.signal,
          onLiveTurnControl: (control) => { if (control) publishControl(control); },
        })) { /* keep the provider frame reader advancing while control awaits a reply */ }
        return null;
      } catch (error) {
        return error;
      }
    })();
    try {
      const control = await controlPublished;
      const steer = control.steer({ clientUserMessageId: 'message_steer_timeout', text: 'Continue this task.' });
      const steerRejected = expect(steer).rejects.toMatchObject({ code: 'native_turn_control_outcome_unknown' });
      await vi.advanceTimersByTimeAsync(15_000);
      await steerRejected;
      expect(vi.getTimerCount()).toBe(0);
      const request = writes.find((message) => message.method === 'turn/steer');
      expect(request).toBeDefined();
      lateResponseId = String(request!.id);
      pushFrame({ id: request!.id, result: { turnId: 'turn_native_1' } });
      expect(wakeFrame).toBeUndefined();
      await lateResponseRead;
      await Promise.resolve();
      controller.abort();
      await running;
    } finally {
      if (wakeFrame) pushFrame({ method: 'turn/completed', params: { threadId: 'thread_native_1', turnId: 'turn_native_1' } });
      controller.abort();
      await running;
      vi.useRealTimers();
    }
  });

  it.each([
    ['full profile', { agentApprovalMode: 'full' as const, approveAllForRun: false }, 'never'],
    ['review profile', { agentApprovalMode: 'review' as const, approveAllForRun: true }, 'on-request'],
    ['legacy approve-all', { approveAllForRun: true }, 'never'],
    ['legacy default', { approveAllForRun: false }, 'on-request'],
  ] as const)('maps %s to the native approval policy', (_label, input, expected) => {
    expect(codexApprovalPolicyForRequest(input)).toBe(expected);
  });

  it.each([
    ['full', 'never', 'danger-full-access'],
    ['review', 'on-request', 'workspace-write'],
  ] as const)('serializes the native %s access profile without downgrading it', async (profile, approvalPolicy, sandbox) => {
    const writes: Array<Record<string, unknown>> = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: `codex-generation-${profile}` }),
      frames: () => ({ stream: framesForAgentProfile(profile), ready: Promise.resolve() }),
      write: async (_generation, message) => { writes.push(message); },
      stop: async () => true,
    });

    for await (const _event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      chatId: `chat-${profile}`,
      prompt: 'Build the requested game.',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'agent',
      accessLevel: 'full',
      agentApprovalMode: profile,
      // Deliberately stale in review to prove the persistent profile wins.
      approveAllForRun: profile === 'review',
    })) { /* drain */ }

    const threadStart = writes.find((message) => message.method === 'thread/start');
    expect(threadStart).toMatchObject({
      params: {
        approvalPolicy,
        sandbox,
      },
    });
    if (profile === 'full') {
      expect(threadStart?.params).not.toHaveProperty('config.sandbox_workspace_write');
    } else {
      expect(threadStart?.params).toMatchObject({
        config: {
          sandbox_workspace_write: {
            writable_roots: ['C:\\workspace'],
            network_access: false,
          },
        },
      });
    }
  });

  it('preserves richer app-server error evidence across a later generic terminal failure', async () => {
    async function* failingFrames() {
      for await (const frame of frames()) {
        if (frame.method === 'turn/completed') {
          yield {
            method: 'error',
            params: {
              threadId: 'thread_native_1',
              turnId: 'turn_native_1',
              error: {
                message: 'Weekly usage exhausted; api_key=private-value',
                code: 'quota_exhausted',
                retryable: false,
                resetAt: 1_900_000_000_000,
              },
            },
          };
          yield {
            method: 'turn/completed',
            params: {
              threadId: 'thread_native_1',
              turnId: 'turn_native_1',
              turn: {
                id: 'turn_native_1',
                status: 'failed',
                error: { message: 'The provider request failed.' },
              },
            },
          };
          return;
        }
        yield frame;
      }
    }

    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'rich-error-generation' }),
      frames: () => ({ stream: failingFrames(), ready: Promise.resolve() }),
      write: async () => undefined,
      stop: async () => true,
    });

    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      prompt: 'Read the marker',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      protectedAttempt: {
        accountId: 'account-1',
        runId: 'run-rich-error',
        requestId: 'request_1',
        attemptNumber: 1,
      },
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: 'Codex app-server reported an error.: Weekly usage exhausted; api_key=[REDACTED]',
      code: 'quota_exhausted',
      providerId: 'openai',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      connectionId: 'openai-codex',
      retryable: false,
      resetAt: 1_900_000_000_000,
      requestId: 'request_1',
      runId: 'run-rich-error',
    });
  });

  it('does not promote a recoverable reconnect notification into the later terminal error', async () => {
    async function* retryingFailureFrames() {
      for await (const frame of frames()) {
        if (frame.method === 'turn/completed') {
          yield {
            method: 'error',
            params: {
              threadId: 'thread_native_1',
              turnId: 'turn_native_1',
              willRetry: true,
              error: { message: 'Reconnecting... 1/5' },
            },
          };
          yield {
            method: 'turn/completed',
            params: {
              threadId: 'thread_native_1',
              turnId: 'turn_native_1',
              turn: {
                id: 'turn_native_1',
                status: 'failed',
                error: { message: 'The provider request failed.' },
              },
            },
          };
          return;
        }
        yield frame;
      }
    }

    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'retrying-error-generation' }),
      frames: () => ({ stream: retryingFailureFrames(), ready: Promise.resolve() }),
      write: async () => undefined,
      stop: async () => true,
    });

    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      prompt: 'Read the marker',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      protectedAttempt: {
        accountId: 'account-1',
        runId: 'run-retrying-error',
        requestId: 'request_1',
        attemptNumber: 1,
      },
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: 'warning', message: 'Reconnecting... 1/5' });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: 'The provider request failed.',
      providerId: 'openai',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      connectionId: 'openai-codex',
      requestId: 'request_1',
      runId: 'run-retrying-error',
    });
    expect(events.find((event) => event.type === 'error')?.message).not.toContain('Reconnecting');
  });

  it('does not enrich a turn failure with a foreign scoped error notification', async () => {
    async function* foreignErrorFrames() {
      for await (const frame of frames()) {
        if (frame.method === 'turn/completed') {
          yield {
            method: 'error',
            params: {
              threadId: 'foreign-thread',
              turnId: 'foreign-turn',
              error: {
                message: 'A different turn exposed a private provider failure.',
                code: 'foreign_provider_failure',
              },
            },
          };
          yield {
            method: 'turn/completed',
            params: {
              threadId: 'thread_native_1',
              turnId: 'turn_native_1',
              turn: {
                id: 'turn_native_1',
                status: 'failed',
                error: { message: 'The provider request failed.' },
              },
            },
          };
          return;
        }
        yield frame;
      }
    }

    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'foreign-error-generation' }),
      frames: () => ({ stream: foreignErrorFrames(), ready: Promise.resolve() }),
      write: async () => undefined,
      stop: async () => true,
    });

    const events: ProviderEvent[] = [];
    for await (const event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      prompt: 'Read the marker',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      protectedAttempt: {
        accountId: 'account-1',
        runId: 'run-foreign-error',
        requestId: 'request_1',
        attemptNumber: 1,
      },
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: 'The provider request failed.',
      providerId: 'openai',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      connectionId: 'openai-codex',
      requestId: 'request_1',
      runId: 'run-foreign-error',
    });
    expect(events.find((event) => event.type === 'error')?.message).not.toContain('private provider');
    expect(events.find((event) => event.type === 'error')).not.toHaveProperty('code', 'foreign_provider_failure');
  });

  it('cancels while subscription acknowledgement is pending', async () => {
    const controller = new AbortController();
    const active = new Set<string>();
    let finish!: (value: IteratorResult<Record<string, unknown>>) => void;
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => {
        active.add('pending-subscription');
        return { generation: 'pending-subscription' };
      },
      frames: () => ({
        ready: new Promise<void>(() => {}),
        stream: {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              queueMicrotask(() => controller.abort());
              return new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
                finish = resolve;
              });
            },
          }),
        },
      }),
      write: async () => {
        throw new Error('must not dispatch');
      },
      stop: async (generation) => {
        finish?.({ done: true, value: undefined });
        return active.delete(generation);
      },
    });
    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1',
        connection,
        codexRoute,
        prompt: 'Read the marker',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
        signal: controller.signal,
      })) {
        /* Cancellation must win over stream-close fallout. */
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
    expect([...active]).toEqual([]);
  });

  it.each(['rejected', 'closed'] as const)(
    'fails and reaps when the native stream is %s before subscription',
    async (stage) => {
      const active = new Set<string>();
      const failure = Promise.reject(new Error('native bridge unavailable'));
      void failure.catch(() => undefined);
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => ({ executableId: 'trusted-codex' }),
        start: async () => {
          active.add('early-end');
          return { generation: 'early-end' };
        },
        frames: () => ({
          ready: new Promise<void>(() => {}),
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                stage === 'rejected'
                  ? failure
                  : Promise.resolve({ done: true as const, value: undefined }),
            }),
          },
        }),
        write: async () => {
          throw new Error('must not dispatch');
        },
        stop: async (generation) => active.delete(generation),
      });
      const consume = async () => {
        for await (const _event of adapter.send!({
          requestId: 'request_1',
          connection,
          codexRoute,
          prompt: 'Read the marker',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          workingDirectory: 'C:\\workspace',
          interactionMode: 'ask',
        })) {
          /* A terminated stream cannot ever acknowledge subscription. */
        }
      };
      const result = await Promise.race([
        consume().then(
          () => 'completed',
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 100)),
      ]);
      expect(result).toBe(
        stage === 'rejected'
          ? 'native bridge unavailable'
          : 'Codex app-server ended before subscription.',
      );
      expect([...active]).toEqual([]);
    },
  );

  it.each(['subscription', 'iterator'] as const)(
    'reaps a child when %s setup throws',
    async (stage) => {
      const active = new Set<string>();
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => ({ executableId: 'trusted-codex' }),
        start: async () => {
          active.add('setup-failure');
          return { generation: 'setup-failure' };
        },
        frames: () => {
          if (stage === 'subscription') throw new Error('native setup failed');
          return {
            ready: Promise.resolve(),
            stream: {
              [Symbol.asyncIterator]() {
                throw new Error('native setup failed');
              },
            },
          };
        },
        write: async () => {
          throw new Error('must not dispatch');
        },
        stop: async (generation) => active.delete(generation),
      });
      const consume = async () => {
        for await (const _event of adapter.send!({
          requestId: 'request_1',
          connection,
          codexRoute,
          prompt: 'Read the marker',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          workingDirectory: 'C:\\workspace',
          interactionMode: 'ask',
        })) {
          /* Setup must retain ownership of the started child. */
        }
      };
      await expect(consume()).rejects.toThrow('native setup failed');
      expect([...active]).toEqual([]);
    },
  );

  it('reaps the started child when native subscription readiness fails', async () => {
    const active = new Set<string>();
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => {
        active.add('failed-subscription');
        return { generation: 'failed-subscription' };
      },
      frames: () => ({ stream: frames(), ready: Promise.reject(new Error('subscription failed')) }),
      write: async () => {
        throw new Error('must not dispatch before subscription');
      },
      stop: async (generation) => active.delete(generation),
    });
    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1',
        connection,
        codexRoute,
        chatId: 'chat_1',
        prompt: 'Read the marker',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
      })) {
        /* Exercise native lifecycle failure. */
      }
    };
    await expect(consume()).rejects.toThrow('subscription failed');
    expect([...active]).toEqual([]);
  });

  it('wraps direct Codex app-server request failures with selected route identity', async () => {
    async function* rejectedFrames() {
      yield {
        id: 'request_1_model_1',
        error: {
          code: -32600,
          providerID: 'stale-provider-label',
          modelID: 'stale-model-label',
          message: 'The selected model was rejected by the native app-server.',
        },
      };
    }
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex' }),
      start: async () => ({ generation: 'request-failure-generation' }),
      frames: () => ({ stream: rejectedFrames(), ready: Promise.resolve() }),
      write: vi.fn(async () => undefined),
      stop: vi.fn(async () => true),
    });
    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1',
        connection,
        codexRoute,
        chatId: 'chat_1',
        prompt: 'Read marker',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
      })) {
        /* A rejected request must retain its structured boundary. */
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'ProviderRuntimeError',
      details: {
        code: '-32600',
        providerId: 'openai',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        connectionId: 'openai-codex',
        requestId: 'request_1',
      },
    });
  });

  it.each(['discovery', 'startup', 'subscription'] as const)(
    'does not send a turn after cancellation during %s',
    async (stage) => {
      const controller = new AbortController();
      const active = new Set<string>();
      const writes: unknown[] = [];
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => {
          if (stage === 'discovery') controller.abort();
          return { executableId: 'trusted-codex' };
        },
        start: async () => {
          active.add('late-generation');
          if (stage === 'startup') controller.abort();
          return { generation: 'late-generation' };
        },
        frames: () => ({
          stream: frames(),
          ready: Promise.resolve().then(() => {
            if (stage === 'subscription') controller.abort();
          }),
        }),
        write: async (_generation, message) => {
          writes.push(message);
        },
        stop: async (generation) => active.delete(generation),
      });
      const consume = async () => {
        for await (const _event of adapter.send!({
          requestId: 'request_1',
          connection,
          codexRoute,
          chatId: 'chat_1',
          prompt: 'Read the marker',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          workingDirectory: 'C:\\workspace',
          interactionMode: 'ask',
          signal: controller.signal,
        })) {
          /* Consume the real adapter lifecycle. */
        }
      };
      await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
      expect(writes).toEqual([]);
      expect([...active]).toEqual([]);
    },
  );

  it('keeps native ingress and the generation alive until the matching interrupt response arrives', async () => {
    const fixture = activeCancellationFixture();
    await fixture.controlPublished;
    fixture.controller.abort();

    const interrupt = fixture.writes.find((frame) => frame.method === 'turn/interrupt');
    expect(interrupt).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread_native_1', turnId: 'turn_native_1' },
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.ingressAborted).toBe(false);

    fixture.pushFrame({ id: 'wrong_interrupt_response', result: {} });
    await fixture.wrongResponseDelivered;
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.ingressAborted).toBe(false);

    fixture.pushFrame({ id: interrupt!.id, result: {} });
    await expect(fixture.settled).resolves.toMatchObject({
      status: 'rejected', error: { name: 'AbortError' },
    });
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledWith('cancel-ack-generation');
    expect(fixture.ingressAborted).toBe(true);
  });

  it('cleans up after a negative interrupt response while preserving cancellation', async () => {
    const fixture = activeCancellationFixture();
    await fixture.controlPublished;
    fixture.controller.abort();
    const interrupt = fixture.writes.find((frame) => frame.method === 'turn/interrupt');
    expect(interrupt).toBeDefined();

    fixture.pushFrame({ id: interrupt!.id, error: { code: 'rejected', message: 'Not active.' } });
    await expect(fixture.settled).resolves.toMatchObject({
      status: 'rejected', error: { name: 'AbortError' },
    });
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.ingressAborted).toBe(true);
  });

  it('bounds cleanup when the interrupt write fails', async () => {
    const fixture = activeCancellationFixture({
      write: (frame) => {
        if (frame.method === 'turn/interrupt') throw new Error('transport closed');
      },
    });
    await fixture.controlPublished;
    fixture.controller.abort();

    await expect(fixture.settled).resolves.toMatchObject({
      status: 'rejected', error: { name: 'AbortError' },
    });
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.ingressAborted).toBe(true);
  });

  it('bounds cleanup when the interrupt response never arrives', async () => {
    vi.useFakeTimers();
    try {
      const fixture = activeCancellationFixture();
      await fixture.controlPublished;
      fixture.controller.abort();
      expect(fixture.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15_000);
      await expect(fixture.settled).resolves.toMatchObject({
        status: 'rejected', error: { name: 'AbortError' },
      });
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      expect(fixture.ingressAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['completion', 'stream end'] as const)(
    'preserves cancellation when %s arrives while awaiting native output',
    async (ending) => {
      const useFakeTimers = ending === 'stream end';
      if (useFakeTimers) vi.useFakeTimers();
      try {
      const controller = new AbortController();
      let interruptResponse: Record<string, unknown> | undefined;
      let resolveInterruptSent!: () => void;
      const interruptSent = new Promise<void>((resolve) => { resolveInterruptSent = resolve; });
      async function* cancelledFrames() {
        for await (const frame of frames()) {
          if ('method' in frame && frame.method === 'turn/completed') {
            controller.abort();
            if (ending === 'stream end') return;
            yield frame;
            if (interruptResponse) yield interruptResponse;
            return;
          }
          yield frame;
        }
      }
      const stop = vi.fn(async () => true);
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => ({ executableId: 'trusted-codex' }),
        start: async () => ({ generation: 'cancelled-generation' }),
        frames: () => ({ stream: cancelledFrames(), ready: Promise.resolve() }),
        write: vi.fn(async (_generation, message) => {
          if (message.method === 'turn/interrupt') {
            interruptResponse = { id: message.id, result: {} };
            resolveInterruptSent();
          }
        }),
        stop,
      });
      const events: ProviderEvent[] = [];
      const consume = async () => {
        for await (const event of adapter.send!({
          requestId: 'request_1',
          connection,
          codexRoute,
          chatId: 'chat_1',
          prompt: 'Read the marker',
          modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          workingDirectory: 'C:\\workspace',
          interactionMode: 'ask',
          signal: controller.signal,
        }))
          events.push(event);
      };
      const cancelled = expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
      await interruptSent;
      if (useFakeTimers) await vi.advanceTimersByTimeAsync(15_000);
      await cancelled;
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(stop).toHaveBeenCalledWith('cancelled-generation');
      } finally {
        if (useFakeTimers) vi.useRealTimers();
      }
    },
  );

  it('reuses the ready managed identity and observes a later explicit refresh', async () => {
    let executableId = 'cli-executable-managed-1';
    const refresh = vi.fn(async () => {
      executableId = executableId.endsWith('-1')
        ? 'cli-executable-managed-2'
        : 'cli-executable-managed-3';
    });
    const findSystem = vi.fn(async () => ({
      executableId: 'cli-executable-system',
      executablePath: 'C:\\trusted\\codex.exe',
    }));
    const manager = {
      refresh,
      getSnapshot: () => ({
        kind: 'ready' as const,
        codexVersion: '0.151.0',
        openCodexVersion: '5.0.0',
        executableId,
      }),
    };

    await expect(resolveCodexExecutable({ manager, findSystem })).resolves.toEqual({
      executableId: 'cli-executable-managed-1',
    });
    await manager.refresh();
    await expect(resolveCodexExecutable({ manager, findSystem })).resolves.toEqual({
      executableId: 'cli-executable-managed-2',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(findSystem).not.toHaveBeenCalled();
  });

  it('selects a newer trusted system Codex for native model discovery and turns', async () => {
    const manager = {
      refresh: vi.fn(async () => undefined),
      getSnapshot: () => ({
        kind: 'ready' as const,
        codexVersion: '0.151.0',
        openCodexVersion: '',
        executableId: 'cli-executable-managed',
      }),
    };
    const system = {
      executableId: 'cli-executable-system',
      executablePath: 'C:\\trusted\\codex.exe',
    };
    const findSystem = vi.fn(async () => system);
    const probeSystemVersion = vi.fn(async () => 'codex-cli 0.155.0-alpha.16.3');
    const dependencies = { manager, findSystem, probeSystemVersion };
    await expect(resolveCodexExecutable(dependencies)).resolves.toEqual(system);
    await expect(resolveCodexExecutable(dependencies)).resolves.toEqual(system);
    expect(findSystem).toHaveBeenCalledTimes(1);
    expect(probeSystemVersion).toHaveBeenCalledTimes(1);
    await expect(resolveCodexExecutable({
      manager, findSystem, probeSystemVersion,
      allowSystemPromotion: async () => false,
    })).resolves.toEqual({ executableId: 'cli-executable-managed' });
    expect(manager.refresh).not.toHaveBeenCalled();
    await expect(resolveCodexExecutable({
      manager, findSystem, probeSystemVersion: async () => 'codex-cli 0.149.0',
    })).resolves.toEqual({ executableId: 'cli-executable-managed' });
    await expect(resolveCodexExecutable({
      manager, findSystem, probeSystemVersion: async () => 'untrusted version text',
    })).resolves.toEqual({ executableId: 'cli-executable-managed' });
  });

  it('falls back only to the existing trusted scan and fails closed when neither exists', async () => {
    const trusted = {
      executableId: 'cli-executable-system',
      executablePath: 'C:\\trusted\\codex.exe',
    };
    const missingManager = {
      refresh: vi.fn(async () => undefined),
      getSnapshot: () => ({ kind: 'missing' as const }),
    };
    await expect(
      resolveCodexExecutable({
        manager: missingManager,
        findSystem: vi.fn(async () => trusted),
      }),
    ).resolves.toEqual(trusted);
    await expect(
      resolveCodexExecutable({
        manager: missingManager,
        findSystem: vi.fn(async () => undefined),
      }),
    ).resolves.toBeUndefined();
  });

  it('does not start the native server when neither executable authority resolves', async () => {
    const start = vi.fn(async () => ({ generation: 'must-not-start' }));
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => undefined,
      start,
      frames: () => ({ stream: frames(), ready: Promise.resolve() }),
      write: vi.fn(async () => undefined),
      stop: vi.fn(async () => true),
    });
    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_missing_authority',
        connection,
        codexRoute,
        chatId: 'chat_missing_authority',
        prompt: 'Hello',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
      })) {
        // No native frame may be observed without an executable authority.
      }
    };

    await expect(consume()).rejects.toThrow('Codex CLI is not installed.');
    expect(start).not.toHaveBeenCalled();
  });

  it('subscribes before dispatch and projects the exact OpenCodex model incrementally', async () => {
    const before = appActivityLog.snapshot().sequence;
    const calls: string[] = [];
    const writes: Array<Record<string, unknown>> = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async (executableId, _ownerId, modelId) => {
        calls.push('start');
        expect(executableId).toBe('trusted-codex');
        expect(modelId).toBe('opencode-go/deepseek-v4-flash-vision-exp');
        return { generation: 'codex-generation-1' };
      },
      frames: () => {
        calls.push('stream');
        return {
          stream: frames(),
          ready: Promise.resolve().then(() => {
            calls.push('subscribed');
          }),
        };
      },
      write: async (_generation, message) => {
        calls.push('write');
        writes.push(message);
      },
      stop: async () => true,
    });
    const events = [];
    for await (const event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      chatId: 'chat_1',
      prompt: 'Please read game.js and report what it does.',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
    })) {
      events.push(event);
    }

    expect(calls.slice(0, 4)).toEqual(['start', 'stream', 'subscribed', 'write']);
    expect(writes.map((message) => message.method)).toEqual([
      'model/list',
      'thread/start',
      'turn/start',
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'session', sessionId: 'thread_native_1' },
        {
          type: 'text',
          delta: 'Working on it.',
          streamPartId: 'message_native_1',
        },
        expect.objectContaining({
          type: 'tool',
          name: 'read',
          status: 'completed',
          callId: 'command_native_1',
          fileLabel: 'game.js',
          result: { exitCode: 0 },
        }),
        { type: 'done', finishReason: 'completed' },
      ]),
    );
    expect(writes[0]).toMatchObject({
      method: 'model/list',
      params: { includeHidden: true },
    });
    expect(writes[1]).toMatchObject({
      method: 'thread/start',
      params: {
        model: 'opencode-go/deepseek-v4-flash-vision-exp',
        modelProvider: 'openai',
        cwd: 'C:\\workspace',
        approvalPolicy: 'never',
        sandbox: 'read-only',
      },
    });
    const timings = appActivityLog
      .snapshot(before)
      .events.filter((event) => event.kind.startsWith('model.prepare.codex.'));
    expect(
      timings.filter((event) => event.phase === 'completed').map((event) => event.kind),
    ).toEqual(
      expect.arrayContaining([
        'model.prepare.codex.start',
        'model.prepare.codex.catalog',
        'model.prepare.codex.thread',
      ]),
    );
    expect(JSON.stringify(timings)).not.toContain('Please read game.js');
    expect(JSON.stringify(timings)).not.toContain('thread_native_1');
    expect(JSON.stringify(timings)).not.toContain('C:\\\\workspace');
  });

  it('fails closed instead of substituting another model', async () => {
    async function* wrongModelFrames() {
      yield {
        id: 'request_1_model_1',
        result: {
          data: [{ model: 'different/model', supportedReasoningEfforts: [], serviceTiers: [] }],
          nextCursor: null,
        },
      };
    }
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-codex', executablePath: 'codex.exe' }),
      start: async () => ({ generation: 'codex-generation-1' }),
      frames: () => ({ stream: wrongModelFrames(), ready: Promise.resolve() }),
      write: vi.fn(async () => undefined),
      stop: async () => true,
    });

    const consume = async () => {
      for await (const _event of adapter.send!({
        requestId: 'request_1',
        connection,
        codexRoute,
        chatId: 'chat_1',
        prompt: 'Hello',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        workingDirectory: 'C:\\workspace',
        interactionMode: 'ask',
      })) {
        // No event is accepted before exact model capability validation.
      }
    };
    await expect(consume()).rejects.toThrow(/model capability mismatch/u);
  });
});

it('delivers native approval requests to the UI handler and resumes the saved native thread', async () => {
  const { replyCodexApproval } = await import('./codexControlBridge');
  const write = vi.fn(async (_generation: string, _message: Record<string, unknown>) => {});
  const requested = vi.fn(async (approval: import('@/lib/harness/types').VibeSpaceApproval) => {
    await replyCodexApproval({
      sessionId: approval.sessionId,
      approvalId: approval.id,
      response: 'reject',
    });
  });
  let runs = 0;
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted' }),
    start: async () => ({ generation: `native-${++runs}` }),
    write,
    stop: async () => true,
    frames: () => ({
      ready: Promise.resolve(),
      stream: (async function* () {
        for await (const frame of frames()) {
          const next = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
          if (runs === 2 && next.id === 'request_1_thread') next.id = 'request_1_resume';
          yield next;
          if (next.method === 'turn/started')
            yield {
              id: 7,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'thread_native_1',
                turnId: 'turn_native_1',
                itemId: 'command_native_1',
                command: 'fixture-command',
              },
            };
        }
      })(),
    }),
  });
  const request = {
    requestId: 'request_1',
    chatId: 'persistent-control-fixture',
    accountId: 'control-fixture',
    connection,
    codexRoute,
    prompt: 'Read marker',
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    workingDirectory: 'C:\\workspace',
    interactionMode: 'ask' as const,
    onApprovalRequested: requested,
  };
  try {
    for (let turn = 0; turn < 2; turn++)
      for await (const _event of adapter.send!(request)) {
        /* collect full turn */
      }
    expect(requested).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith('native-1', { id: 7, result: { decision: 'decline' } });
    expect(
      write.mock.calls.some(
        (call: unknown[]) => (call[1] as { method?: string })?.method === 'thread/resume',
      ),
    ).toBe(true);
  } finally {
    localStorage.clear();
  }
});

it('never dispatches a turn after cancellation while binding its session', async () => {
  const controller = new AbortController();
  const writes: Record<string, unknown>[] = [];
  const adapter = createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted-binding-race' }),
    start: async () => ({ generation: 'binding-race-generation' }),
    frames: () => ({ ready: Promise.resolve(), stream: frames() }),
    write: async (_generation, frame) => {
      writes.push(frame);
    },
    stop: async () => true,
  });
  const consume = async () => {
    for await (const _event of adapter.send!({
      requestId: 'request_1',
      connection,
      codexRoute,
      prompt: 'Read marker',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask',
      signal: controller.signal,
      onSessionBound: async () => {
        controller.abort();
      },
    })) {
      /* consume real adapter events */
    }
  };
  await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
  expect(writes.map((frame) => frame.method)).not.toContain('turn/start');
});

it.each(['binding', 'approval'] as const)(
  'cancels a pending %s projection and releases the next turn',
  async (phase) => {
    const controller = new AbortController();
    let entered!: () => void;
    let releaseProjection!: () => void;
    const projectionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pendingProjection = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    let approvalId: string | undefined;
    let interruptResponse: Record<string, unknown> | undefined;
    let runs = 0;
    const writes: Record<string, unknown>[] = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'trusted-projection-race' }),
      start: async () => ({ generation: 'projection-race-' + ++runs }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          for await (const frame of frames()) {
            yield frame;
            if (phase === 'approval' && runs === 1 && frame.method === 'turn/started') {
              yield {
                id: 42,
                method: 'item/commandExecution/requestApproval',
                params: {
                  threadId: 'thread_native_1',
                  turnId: 'turn_native_1',
                  itemId: 'command_native_1',
                  command: 'fixture-command',
                },
              };
            }
          }
          if (runs === 1 && interruptResponse) yield interruptResponse;
        })(),
      }),
      write: async (_generation, frame) => {
        writes.push(frame);
        if (frame.method === 'turn/interrupt') interruptResponse = { id: frame.id, result: {} };
      },
      stop: async () => true,
    });
    const request = {
      requestId: 'request_1',
      connection,
      codexRoute,
      prompt: 'Read marker',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      workingDirectory: 'C:\\workspace',
      interactionMode: 'ask' as const,
    };
    const consume = async () => {
      for await (const _event of adapter.send!({
        ...request,
        signal: controller.signal,
        onSessionBound:
          phase === 'binding'
            ? async () => {
                entered();
                await pendingProjection;
              }
            : undefined,
        onApprovalRequested: async (approval) => {
          approvalId = approval.id;
          entered();
          await pendingProjection;
        },
      })) {
        /* do not bypass the adapter or its lease */
      }
    };
    const completion = consume().then(
      () => 'completed',
      (error) => error.name as string,
    );
    await projectionEntered;
    controller.abort();
    const outcome = await Promise.race([
      completion,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    let lateReply: string | undefined;
    if (approvalId) {
      const { replyCodexApproval } = await import('./codexControlBridge');
      lateReply = await replyCodexApproval({
        sessionId: 'thread_native_1',
        approvalId,
        response: 'reject',
      }).then(
        () => 'accepted',
        () => 'rejected',
      );
    }
    // Clean up the RED candidate without leaving a pending lease behind.
    releaseProjection();
    await completion;
    expect(outcome).toBe('AbortError');
    if (phase === 'approval') expect(lateReply).toBe('rejected');
    else expect(writes.map((frame) => frame.method)).not.toContain('turn/start');
    const nextEvents: ProviderEvent[] = [];
    for await (const event of adapter.send!(request)) nextEvents.push(event);
    expect(runs).toBe(2);
    expect(nextEvents).toContainEqual({ type: 'done', finishReason: 'completed' });
  },
);
