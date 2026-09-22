import { describe, expect, it, vi } from 'vitest';
import { nativeOpenCodeEvents, nativeOpenCodeRequest } from './openCodeNativeTransport';

const nativeEvent = (data: string, sequence = 1) => ({
  kind: 'event' as const,
  data,
  sequence,
  nativeHandoffWallUs: 1_789_300_000_000_000 + sequence,
  nativeHandoffMonotonicUs: 1_000 + sequence,
});

describe('native OpenCode transport', () => {
  it('bounds unresolved distinct native reads without evicting or replaying them', async () => {
    const completions: ((value: unknown) => void)[] = [];
    const invoke = vi.fn(() => new Promise(resolve => completions.push(resolve)));
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    const reads = Array.from({ length: 64 }, (_, index) => nativeOpenCodeRequest('generation', '/session/s'+index+'/message', {}, 1000, bridge));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(64));
    await expect(nativeOpenCodeRequest('generation', '/session/overflow/message', {}, 1000, bridge)).rejects.toThrow(/read queue is full/);
    expect(invoke).toHaveBeenCalledTimes(64);
    for (const finish of completions) finish({ status: 200, statusText: 'OK', body: '[]' });
    await Promise.all(reads);
    invoke.mockImplementation(async () => ({ status: 200, statusText: 'OK', body: '[]' }));
    expect((await nativeOpenCodeRequest('generation', '/session/overflow/message', {}, 1000, bridge)).status).toBe(200);
  });


  it('shares an unresolved native GET after a caller deadline, then reads fresh after settlement', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void;
      const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
      const bridge = async () => ({ invoke, channel: vi.fn() as never });
      const first = nativeOpenCodeRequest('generation', '/session/status', {}, 20, bridge);
      const expired = expect(first).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(21); await expired;
      const second = nativeOpenCodeRequest('generation', '/session/status', {}, 100, bridge);
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(1);
      finish({ status: 200, statusText: 'OK', body: '{}' });
      expect(await (await second).json()).toEqual({});
      const fresh = nativeOpenCodeRequest('generation', '/session/status', {}, 100, bridge);
      await vi.advanceTimersByTimeAsync(0); expect(invoke).toHaveBeenCalledTimes(2);
      finish({ status: 200, statusText: 'OK', body: '{"fresh":true}' });
      expect(await (await fresh).json()).toEqual({ fresh: true });
    } finally { vi.useRealTimers(); }
  });

  it('keeps caller cancellation independent of a shared native read', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    const controller = new AbortController();
    const first = nativeOpenCodeRequest('generation', '/global/health', { signal: controller.signal }, 1000, bridge);
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = nativeOpenCodeRequest('generation', '/global/health', {}, 1000, bridge);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    controller.abort(); await cancelled;
    expect(invoke).toHaveBeenCalledTimes(1);
    finish({ status: 200, statusText: 'OK', body: '{}' });
    expect((await second).status).toBe(200);
  });

  it('never combines distinct generations, directories, routes, or explicit mutations', async () => {
    const completions: ((value: unknown) => void)[] = [];
    const invoke = vi.fn(() => new Promise(resolve => completions.push(resolve)));
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    const calls = [
      nativeOpenCodeRequest('one', '/session/a/message?limit=100', {}, 1000, bridge),
      nativeOpenCodeRequest('two', '/session/a/message?limit=100', {}, 1000, bridge),
      nativeOpenCodeRequest('one', '/session/a/message?limit=50', {}, 1000, bridge),
      nativeOpenCodeRequest('one', '/session/a/message?limit=100&directory=C%3A%5Cexact', {}, 1000, bridge),
      ...[1, 2].map(() => nativeOpenCodeRequest('one', '/session/a/abort', { method: 'POST' }, 1000, bridge)),
    ];
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(6));
    for (const finish of completions) finish({ status: 200, statusText: 'OK', body: '{}' });
    await Promise.all(calls);
  });

  it('releases a rejected native read so an explicit later read can recover', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('native disconnected')).mockResolvedValue({ status: 200, statusText: 'OK', body: '{}' });
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    await expect(nativeOpenCodeRequest('generation', '/global/health', {}, 1000, bridge)).rejects.toThrow('native disconnected');
    expect((await nativeOpenCodeRequest('generation', '/global/health', {}, 1000, bridge)).status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(2);
  });


  it('recovers pending permissions through a read-only generation-bound native route', async () => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: '[]' }));
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    await nativeOpenCodeRequest('generation', '/permission?directory=C%3A%5Cproject', {}, 5000, bridge);
    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: expect.objectContaining({ generation: 'generation', route: { kind: 'permission_list' }, directory: 'C:\\project' }),
    });
    await expect(nativeOpenCodeRequest('generation', '/permission', { method: 'POST' }, 5000, bridge)).rejects.toThrow(/route/i);
  });
  it('settles a pending native request promptly on caller cancellation', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(() => new Promise<never>(() => {}));
    const pending = nativeOpenCodeRequest('opencode-server-generation', '/global/health',
      { signal: controller.signal }, 5000, async () => ({ invoke, channel: vi.fn() as never }));
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
  }, 1000);

  it('bounds a native IPC request even if its native timeout never returns', async () => {
    vi.useFakeTimers();
    try {
      const pending = nativeOpenCodeRequest('opencode-server-generation', '/global/health', {},
        50, async () => ({ invoke: vi.fn(() => new Promise<never>(() => {})), channel: vi.fn() as never }));
      const assertion = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally { vi.useRealTimers(); }
  }, 1000);
  it('sends only generation-bound request metadata through the native command', async () => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: '{"healthy":true}' }));
    const response = await nativeOpenCodeRequest(
      'opencode-server-generation',
      '/global/health?directory=C%3A%5Cworkspace',
      { method: 'GET' },
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );

    expect(await response.json()).toEqual({ healthy: true });
    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: {
        generation: 'opencode-server-generation',
        route: { kind: 'health' },
        directory: 'C:\\workspace',
        body: undefined,
        timeoutMs: 5_000,
      },
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/authorization|password|basic/i);
  });

  it('maps the command catalog GET used before session commands', async () => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: '[]' }));
    await nativeOpenCodeRequest(
      'opencode-server-generation',
      '/command?directory=C%3A%5Cworkspace',
      {},
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );

    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: expect.objectContaining({
        route: { kind: 'command_list' },
        directory: 'C:\\workspace',
        body: undefined,
      }),
    });
  });

  it('keeps the command catalog route read-only and exact', async () => {
    const invoke = vi.fn();
    const bridge = async () => ({ invoke, channel: vi.fn() as never });
    await expect(
      nativeOpenCodeRequest('opencode-server-generation', '/command?unexpected=true', {}, 5_000, bridge),
    ).rejects.toThrow(/query is invalid/u);
    await expect(
      nativeOpenCodeRequest('opencode-server-generation', '/command', { method: 'POST', body: '{}' }, 5_000, bridge),
    ).rejects.toThrow(/route is invalid/u);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])('constructs bodyless HTTP %s responses', async (status) => {
    const invoke = vi.fn(async () => ({ status, statusText: 'No Content', body: '' }));

    const response = await nativeOpenCodeRequest(
      'opencode-server-generation',
      '/session/session-1/prompt_async',
      { method: 'POST', body: '{"parts":[{"type":"text","text":"hello"}]}' },
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );

    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
  });

  it('maps the supported session command route with its exact execution agent', async () => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: 'true' }));
    await nativeOpenCodeRequest(
      'opencode-server-generation',
      '/session/session-1/command',
      {
        method: 'POST',
        body: JSON.stringify({
          command: 'goal',
          arguments: 'Finish the verified workflow',
          model: 'opencode-go/deepseek-v4-flash-vision-exp',
          agent: 'vibespace-full',
        }),
      },
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );

    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: expect.objectContaining({
        route: { kind: 'session_command', sessionId: 'session-1' },
      }),
    });
  });

  it('rejects unsupported session permission mutation instead of pretending PATCH applies it', async () => {
    const invoke = vi.fn();
    await expect(
      nativeOpenCodeRequest(
        'opencode-server-generation',
        '/session/session-1',
        { method: 'PATCH', body: '{"permission":[]}' },
        5_000,
        async () => ({ invoke, channel: vi.fn() as never }),
      ),
    ).rejects.toThrow(/route is invalid/u);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/mcp?directory=C%3A%5Cworkspace', { kind: 'mcp_status' }],
    ['POST', '/mcp?directory=C%3A%5Cworkspace', { kind: 'mcp_add' }],
    [
      'POST',
      '/mcp/github%3Acopilot/connect?directory=C%3A%5Cworkspace',
      { kind: 'mcp_connect', name: 'github:copilot' },
    ],
    [
      'POST',
      '/mcp/github%3Acopilot/disconnect?directory=C%3A%5Cworkspace',
      { kind: 'mcp_disconnect', name: 'github:copilot' },
    ],
  ] as const)('maps the exact OpenCode MCP route %s %s', async (method, path, route) => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: '{}' }));
    await nativeOpenCodeRequest(
      'opencode-server-generation',
      path,
      {
        method,
        ...(method === 'POST' && path.startsWith('/mcp?')
          ? {
              body: JSON.stringify({
                name: 'github',
                config: { type: 'remote', url: 'https://mcp.example.test/rpc', enabled: true },
              }),
            }
          : {}),
      },
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );
    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: expect.objectContaining({
        route,
        directory: 'C:\\workspace',
      }),
    });
  });

  it.each([
    ['GET', '/question?directory=C%3A%5Cworkspace', undefined, { kind: 'question_list' }],
    [
      'POST',
      '/question/que_exact/reply?directory=C%3A%5Cworkspace',
      JSON.stringify({ answers: [['Snake'], ['Current project folder']] }),
      { kind: 'question_reply', requestId: 'que_exact' },
    ],
    [
      'POST',
      '/question/que_exact/reject?directory=C%3A%5Cworkspace',
      undefined,
      { kind: 'question_reject', requestId: 'que_exact' },
    ],
  ] as const)('maps the exact OpenCode question route %s %s', async (method, path, body, route) => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: 'true' }));
    await nativeOpenCodeRequest(
      'opencode-server-generation',
      path,
      { method, ...(body === undefined ? {} : { body }) },
      5_000,
      async () => ({ invoke, channel: vi.fn() as never }),
    );
    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: expect.objectContaining({ route, directory: 'C:\\workspace', body }),
    });
  });

  it.each([
    ['GET', '/question/que_exact/reply'],
    ['DELETE', '/question/que_exact/reject'],
    ['POST', '/question/que_exact/unknown'],
    ['POST', '/question/que_exact/reply?unexpected=true'],
  ])('rejects a non-canonical OpenCode question route %s %s', async (method, path) => {
    const invoke = vi.fn();

    await expect(
      nativeOpenCodeRequest('opencode-server-generation', path, { method }, 5_000, async () => ({
        invoke,
        channel: vi.fn() as never,
      })),
    ).rejects.toThrow(/OpenCode native transport (route|query) is invalid\./u);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('delivers native channel events and cancels the exact generation stream', async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string, _args: Record<string, unknown>) => {
      if (command === 'opencode_server_event_stream') {
        queueMicrotask(() => {
          onmessage?.(nativeEvent(
            JSON.stringify({ type: 'message.part.updated', properties: { delta: 'hello' } }),
            7,
          ));
          onmessage?.({ kind: 'done' });
        });
      }
      return command === 'opencode_server_event_cancel' ? true : undefined;
    });
    const bridge = async () => ({
      invoke,
      channel: (handler: (message: unknown) => void) => {
        onmessage = handler;
        return { onmessage: handler };
      },
    });

    const received = [];
    for await (const event of nativeOpenCodeEvents(
      'opencode-server-generation',
      '/event?directory=C%3A%5Cworkspace',
      undefined,
      bridge,
    )) {
      received.push(event);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'message.part.updated',
      properties: { delta: 'hello' },
      nativeTiming: {
        generation: 'opencode-server-generation',
        sequence: 7,
        nativeHandoffWallUs: 1_789_300_000_000_007,
        nativeHandoffMonotonicUs: 1_007,
        rendererReceivedAt: expect.any(Number),
        rendererReceivedMonotonicMs: expect.any(Number),
      },
    });
    const start = invoke.mock.calls.find(([command]) => command === 'opencode_server_event_stream');
    const cancel = invoke.mock.calls.find(
      ([command]) => command === 'opencode_server_event_cancel',
    );
    expect(start?.[1]).toMatchObject({
      generation: 'opencode-server-generation',
      directory: 'C:\\workspace',
    });
    expect(cancel?.[1]).toMatchObject({
      generation: 'opencode-server-generation',
      streamId: expect.stringMatching(/^opencode-stream-[a-f0-9]+$/u),
    });
  });

  it.each([
    ['event count', Array.from({ length: 257 }, () => JSON.stringify({ type: 'ping' }))],
    [
      'queued bytes',
      Array.from({ length: 9 }, () =>
        JSON.stringify({ type: 'ping', properties: { payload: 'x'.repeat(1_048_576) } }),
      ),
    ],
  ])('fails closed when native events overflow the renderer queue by %s', async (_kind, data) => {
    let onmessage: ((message: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'opencode_server_event_stream') {
        for (const [index, item] of data.entries()) onmessage?.(nativeEvent(item, index + 1));
      }
      return command === 'opencode_server_event_cancel' ? true : undefined;
    });
    const bridge = async () => ({
      invoke,
      channel: (handler: (message: unknown) => void) => {
        onmessage = handler;
        return { onmessage: handler };
      },
    });

    const consume = async () => {
      for await (const _event of nativeOpenCodeEvents(
        'opencode-server-generation',
        '/event',
        undefined,
        bridge,
      )) {
        // The producer fills the queue synchronously before the first event can be consumed.
      }
    };

    await expect(consume()).rejects.toThrow('OpenCode native event queue exceeded safe limits.');
    expect(invoke).toHaveBeenCalledWith(
      'opencode_server_event_cancel',
      expect.objectContaining({ generation: 'opencode-server-generation' }),
    );
  });

  it('cancels without yielding when the caller aborts', async () => {
    let onmessage: ((message: unknown) => void) | undefined;
    const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => undefined);
    const controller = new AbortController();
    const bridge = async () => ({
      invoke,
      channel: (handler: (message: unknown) => void) => {
        onmessage = handler;
        return { onmessage: handler };
      },
    });
    const consume = (async () => {
      for await (const _event of nativeOpenCodeEvents(
        'opencode-server-generation',
        '/event',
        controller.signal,
        bridge,
      )) {
        throw new Error('unexpected event');
      }
    })();

    await Promise.resolve();
    controller.abort();
    onmessage?.({ kind: 'done' });
    await consume;
    expect(invoke).toHaveBeenCalledWith(
      'opencode_server_event_cancel',
      expect.objectContaining({ generation: 'opencode-server-generation' }),
    );
  });
});
