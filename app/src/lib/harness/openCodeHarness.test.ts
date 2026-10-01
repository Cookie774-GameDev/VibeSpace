import { describe, expect, it, vi } from 'vitest';
import { OpenCodeHarness } from './openCodeHarness';
import type { HarnessRuntimeManager, OpenCodeServerConnection } from './runtimeManager';
import type { HarnessEvent, HarnessSendRequest } from './types';

const connection: OpenCodeServerConnection = {
  baseUrl: 'http://127.0.0.1:43123/',
  username: 'vibespace',
  password: 's'.repeat(64),
  source: 'system',
  version: '1.2.3',
  generation: 'opencode-server-test',
};

function runtime(): HarnessRuntimeManager {
  return {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => ({ kind: 'ready', source: 'system', version: '1.2.3' }) as const),
    getConnection: vi.fn(() => connection),
    refresh: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

function sse(...values: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        values.forEach((value, index) => {
          const data = typeof value === 'string' ? value : JSON.stringify(value);
          controller.enqueue(encoder.encode(`id: ${index + 1}\ndata: ${data}\n\n`));
        });
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function providerResponse(providerId = 'anthropic', modelId = 'claude'): Response {
  return new Response(
    JSON.stringify({
      providers: [
        {
          id: providerId,
          name: providerId,
          models: { [modelId]: { name: modelId } },
        },
      ],
    }),
  );
}

function request(signal?: AbortSignal): HarnessSendRequest {
  return {
    sessionId: 'session-1',
    selection: { providerId: 'anthropic', modelId: 'claude' },
    parts: [{ type: 'text', text: 'hello' }],
    ...(signal ? { signal } : {}),
  };
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OpenCodeHarness', () => {
  it('creates VibeSpace sessions without leaking OpenCode response shapes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'oc-1', title: 'Chat', extra: true })));
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(
      harness.createSession({
        chatId: 'chat-1',
        title: 'Chat',
        parentSessionId: 'oc-parent',
        workingDirectory: 'C:\\workspace',
      }),
    ).resolves.toEqual({
      id: 'oc-1',
      chatId: 'chat-1',
      parentSessionId: 'oc-parent',
    });
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('directory')).toBe(
      'C:\\workspace',
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      title: 'Chat',
      parentID: 'oc-parent',
    });
  });

  it('subscribes before prompting and streams normalized session events', async () => {
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/config/providers') return providerResponse();
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              delta: 'Hello',
              part: { type: 'text' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      return new Response(null, { status: 204 });
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(
      collect(harness.send({ ...request(), workingDirectory: 'C:\\workspace' })),
    ).resolves.toEqual([
      { type: 'assistant.delta', text: 'Hello' },
      { type: 'done', finishReason: 'idle' },
    ]);
    expect(calls.slice(0, 3)).toEqual([
      'GET /config/providers',
      'GET /event',
      'POST /session/session-1/prompt_async',
    ]);
    expect(
      fetch.mock.calls
        .filter(([url]) =>
          ['/event', '/session/session-1/prompt_async'].includes(new URL(String(url)).pathname),
        )
        .map(([url]) => new URL(String(url)).searchParams.get('directory')),
    ).toEqual(['C:\\workspace', 'C:\\workspace']);
  });

  it('waits for the OpenCode event stream handshake before submitting a fast prompt', async () => {
    let streamConnected = false;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse();
      if (path === '/event') {
        await new Promise((resolve) => setTimeout(resolve, 0));
        streamConnected = true;
        return sse(
          { type: 'server.connected', properties: {} },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              delta: 'Fast response',
              part: { type: 'text' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) {
        return streamConnected
          ? new Response(null, { status: 204 })
          : new Response('prompt submitted before event stream handshake', { status: 409 });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(collect(harness.send(request()))).resolves.toEqual([
      { type: 'assistant.delta', text: 'Fast response' },
      { type: 'done', finishReason: 'idle' },
    ]);
  });

  it('recovers the latest assistant text snapshot when OpenCode omits text deltas', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse('ollama', 'llama3.2:latest');
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          {
            type: 'message.updated',
            properties: {
              sessionID: 'session-1',
              info: { id: 'message-user', role: 'user' },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              part: {
                id: 'part-user',
                messageID: 'message-user',
                type: 'text',
                text: 'Do not echo this user prompt.',
              },
            },
          },
          {
            type: 'message.updated',
            properties: {
              sessionID: 'session-1',
              info: { id: 'message-assistant', role: 'assistant' },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              part: {
                id: 'part-assistant',
                messageID: 'message-assistant',
                type: 'text',
                text: 'The oversized paragraph remains larger than the shard limit.',
              },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(
      collect(
        harness.send({
          ...request(),
          selection: { providerId: 'ollama', modelId: 'llama3.2:latest' },
        }),
      ),
    ).resolves.toEqual([
      {
        type: 'assistant.delta',
        text: 'The oversized paragraph remains larger than the shard limit.',
      },
      { type: 'done', finishReason: 'idle' },
    ]);
  });

  it('reconnects, suppresses duplicates, and ignores malformed or cross-session events', async () => {
    let eventRequests = 0;
    const duplicate = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        delta: 'one',
        part: { type: 'text' },
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse();
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (path === '/session/session-1') {
        return new Response(JSON.stringify({ id: 'session-1' }), { status: 200 });
      }
      if (path === '/event') {
        eventRequests += 1;
        return eventRequests === 1
          ? sse({ type: 'server.connected', properties: {} }, duplicate)
          : sse(
              { type: 'server.connected', properties: {} },
              duplicate,
              '{broken',
              {
                type: 'message.part.updated',
                properties: {
                  sessionID: 'session-2',
                  delta: 'not ours',
                  part: { type: 'text' },
                },
              },
              { type: 'session.idle', properties: { sessionID: 'session-1' } },
            );
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), {
      fetch,
      reconnectDelay: async () => undefined,
    });

    await expect(collect(harness.send(request()))).resolves.toEqual([
      { type: 'assistant.delta', text: 'one' },
      { type: 'done', finishReason: 'idle' },
    ]);
    expect(eventRequests).toBe(2);
  });

  it('does not wait for a hanging /config/providers scan before submitting the prompt', async () => {
    let promptAt = 0;
    const started = Date.now();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') {
        return new Promise(() => undefined);
      }
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              delta: 'Hi',
              part: { type: 'text' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) {
        promptAt = Date.now() - started;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), {
      fetch,
      providerCatalogTimeoutMs: 20,
    });

    await expect(collect(harness.send(request()))).resolves.toEqual([
      { type: 'assistant.delta', text: 'Hi' },
      { type: 'done', finishReason: 'idle' },
    ]);
    expect(promptAt).toBeGreaterThan(0);
    expect(promptAt).toBeLessThan(1_500);
  });

  it('reuses a warm provider catalog on the next send', async () => {
    let providerFetches = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') {
        providerFetches += 1;
        return providerResponse();
      }
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          {
            type: 'message.part.updated',
            properties: {
              sessionID: 'session-1',
              delta: 'ok',
              part: { type: 'text' },
            },
          },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });
    await collect(harness.send(request()));
    await collect(harness.send(request()));
    expect(providerFetches).toBe(1);
  });

  it('honors cancellation and aborts the active OpenCode session', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse();
      if (path === '/event') {
        controller.abort();
        return sse({ type: 'server.connected', properties: {} });
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (path.endsWith('/abort')) return new Response('true', { status: 200 });
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(collect(harness.send(request(controller.signal)))).resolves.toEqual([]);
    expect(fetch.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/abort'))).toBe(
      true,
    );
  });

  it('emits a sanitized terminal error when the server dies and recovery fails', async () => {
    const secretFailure = `server ${connection.password} died`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse();
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      if (path === '/event') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
                ),
              );
              setTimeout(() => controller.error(new Error(secretFailure)), 0);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (path === '/session/session-1') throw new Error(secretFailure);
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), {
      fetch,
      maxReconnectAttempts: 1,
      reconnectDelay: async () => undefined,
    });

    const events = await collect(harness.send(request()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'HARNESS_CRASHED' });
    const message = events[0]?.type === 'error' ? events[0].message : '';
    expect(message).toContain('retry the active turn');
    expect(message).not.toContain(connection.password);
  });

  it('submits only the exact reconciled OpenCode provider and model identity', async () => {
    let promptBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config/providers') return providerResponse('ollama', 'qwen3:4b');
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) {
        promptBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await collect(
      harness.send({
        ...request(),
        selection: { providerId: 'local', modelId: 'qwen3:4b' },
        agent: 'vibespace',
        variant: 'high',
        tools: { 'terminal.list': true, 'terminal.write': false },
      }),
    );

    expect(promptBody).toMatchObject({
      model: { providerID: 'ollama', modelID: 'qwen3:4b' },
      agent: 'vibespace',
      variant: 'high',
      tools: { 'terminal.list': true, 'terminal.write': false },
    });
  });

  it('binds a verified non-US Qwen endpoint before catalog resolution and prompt dispatch', async () => {
    const endpoint = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/config' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          provider: { qwen: { options: { baseURL: endpoint } } },
        });
        return new Response(JSON.stringify({ provider: {} }), { status: 200 });
      }
      if (path === '/config/providers') return providerResponse('qwen', 'qwen3.7-plus');
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), {
      fetch,
      qwenEndpoint: () => endpoint,
    });

    await collect(
      harness.send({
        ...request(),
        selection: { providerId: 'qwen', modelId: 'qwen3.7-plus' },
      }),
    );

    expect(calls.slice(0, 4)).toEqual([
      'PATCH /config',
      'GET /config/providers',
      'GET /event',
      'POST /session/session-1/prompt_async',
    ]);
  });

  it('fails closed before Qwen catalog or prompt access without a verified endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const harness = new OpenCodeHarness(runtime(), {
      fetch,
      qwenEndpoint: () => undefined,
    });

    await expect(
      collect(
        harness.send({
          ...request(),
          selection: { providerId: 'qwen', modelId: 'qwen3.7-plus' },
        }),
      ),
    ).resolves.toEqual([
      {
        type: 'error',
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'Qwen has no endpoint authenticated by the current credential.',
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reapplies Qwen configuration when the verified endpoint changes', async () => {
    let endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const patched: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/config' && init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)).provider.qwen.options.baseURL);
        return new Response(JSON.stringify({ provider: {} }), { status: 200 });
      }
      if (path === '/config/providers') return providerResponse('qwen', 'qwen3.7-plus');
      if (path === '/event') {
        return sse(
          { type: 'server.connected', properties: {} },
          { type: 'session.idle', properties: { sessionID: 'session-1' } },
        );
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
    const harness = new OpenCodeHarness(runtime(), { fetch, qwenEndpoint: () => endpoint });

    await collect(
      harness.send({
        ...request(),
        selection: { providerId: 'qwen', modelId: 'qwen3.7-plus' },
      }),
    );
    endpoint = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    await collect(
      harness.send({
        ...request(),
        selection: { providerId: 'qwen', modelId: 'qwen3.7-plus' },
      }),
    );

    expect(patched).toEqual([
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    ]);
  });

  it('surfaces an exact unavailable-model error before opening a stream or prompt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(providerResponse());
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await expect(
      collect(
        harness.send({
          ...request(),
          selection: { providerId: 'anthropic', modelId: 'not-available' },
        }),
      ),
    ).resolves.toEqual([
      {
        type: 'error',
        code: 'MODEL_NOT_AVAILABLE',
        message: 'Model "not-available" is not available for "anthropic".',
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe('/config/providers');
  });

  it('disposes active streams and the scoped server instance', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('true'));
    const harness = new OpenCodeHarness(runtime(), { fetch });

    await harness.dispose();

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/instance/dispose',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
