import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent } from './types';
import { createCodexPersistentAdapter, resolveCodexExecutable } from './codexPersistent';

const connection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-app-server',
  providerId: 'opencode-go',
  displayName: 'Codex via OpenCodex',
  mode: 'external-cli',
  authSource: 'opencode-provider-session',
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

describe('persistent Codex app-server adapter', () => {
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
        {
          type: 'tool',
          name: 'read',
          status: 'completed',
          callId: 'command_native_1',
          fileLabel: 'game.js',
          result: { exitCode: 0 },
        },
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
    await replyCodexApproval({ sessionId: approval.sessionId, approvalId: approval.id, response: 'reject' });
  });
  let runs = 0;
  const adapter = createCodexPersistentAdapter({ findExecutable: async () => ({ executableId: 'trusted' }),
    start: async () => ({ generation: `native-${++runs}` }), write, stop: async () => true,
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      for await (const frame of frames()) {
        const next = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
        if (runs === 2 && next.id === 'request_1_thread') next.id = 'request_1_resume';
        yield next;
        if (next.method === 'turn/started') yield { id: 7, method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread_native_1', turnId: 'turn_native_1', itemId: 'command_native_1', command: 'fixture-command' } };
      }
    })() }),
  });
  const request = { requestId: 'request_1', chatId: 'persistent-control-fixture', accountId: 'control-fixture',
    connection, prompt: 'Read marker', modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    workingDirectory: 'C:\\workspace', interactionMode: 'ask' as const, onApprovalRequested: requested };
  try {
    for (let turn = 0; turn < 2; turn++) for await (const _event of adapter.send!(request)) { /* collect full turn */ }
    expect(requested).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith('native-1', { id: 7, result: { decision: 'decline' } });
    expect(write.mock.calls.some((call: unknown[]) => (call[1] as { method?: string })?.method === 'thread/resume')).toBe(true);
  } finally { localStorage.clear(); }
});
