import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent } from './types';
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

describe('persistent Codex app-server adapter', () => {
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

  it.each(['completion', 'stream end'] as const)(
    'preserves cancellation when %s arrives while awaiting native output',
    async (ending) => {
      const controller = new AbortController();
      async function* cancelledFrames() {
        for await (const frame of frames()) {
          if ('method' in frame && frame.method === 'turn/completed') {
            controller.abort();
            if (ending === 'stream end') return;
          }
          yield frame;
        }
      }
      const stop = vi.fn(async () => true);
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => ({ executableId: 'trusted-codex' }),
        start: async () => ({ generation: 'cancelled-generation' }),
        frames: () => ({ stream: cancelledFrames(), ready: Promise.resolve() }),
        write: vi.fn(async () => undefined),
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
      await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(stop).toHaveBeenCalledWith('cancelled-generation');
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
        })(),
      }),
      write: async (_generation, frame) => {
        writes.push(frame);
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
