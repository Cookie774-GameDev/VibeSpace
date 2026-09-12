import { afterEach, beforeEach, vi } from 'vitest';
import type { Agent } from '@/types/agent';
import { useAuthStore } from '@/stores/auth';
import { _resetNativeFetchForTests } from '@/lib/nativeFetch';
import { writeLocalAgentPreferences } from '../localAgentRuntime';
import {
  buildOllamaRequestBody,
  inspectOllamaModel,
  listOllamaModelInfo,
  pullOllamaModel,
  isOllamaReachable,
  ollamaProvider,
  probeOllamaToolCalling,
  removeOllamaModel,
  runLegacyNativeOllamaChat,
  runNativeOllamaChat,
  runReliableNativeOllamaChat,
  toOllamaNativeMessages,
  verifyOllamaModelChat,
} from './ollama';

describe('ollama provider utilities', () => {
  beforeEach(() => {
    useAuthStore.setState({
      apiKeys: { ollama: 'http://127.0.0.1:11434' },
    });
    _resetNativeFetchForTests(null);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetNativeFetchForTests(null);
  });

  it('lists installed model metadata from /api/tags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'llama3.2:latest',
            size: 2_013_265_920,
            modified_at: '2026-06-07T10:00:00Z',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listOllamaModelInfo()).resolves.toEqual([
      {
        name: 'llama3.2:latest',
        size: 2_013_265_920,
        modifiedAt: '2026-06-07T10:00:00Z',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('checks reachability via /api/version', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"version":"0.6.0"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isOllamaReachable()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reads capability and context metadata from the bounded model-details endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        capabilities: ['completion', 'tools'],
        model_info: {
          'llama.context_length': 65_536,
          'llama.embedding_length': 4_096,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(inspectOllamaModel('llama3.2')).resolves.toEqual({
      digest: expect.stringMatching(/^metadata:[a-f0-9]{8}$/),
      capabilities: ['completion', 'tools'],
      contextWindowTokens: 65_536,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/show',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'llama3.2', verbose: false }),
      }),
    );
  });

  it('uses a side-effect-free tool schema for the local compatibility roundtrip', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([
        expect.objectContaining({
          function: expect.objectContaining({ name: 'compatibility_check' }),
        }),
      ]);
      expect(JSON.stringify(body)).not.toMatch(/workspace|shell|file|write/i);
      return Promise.resolve(
        jsonResponse({
          message: {
            tool_calls: [{ function: { name: 'compatibility_check', arguments: { ok: true } } }],
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeOllamaToolCalling('qwen3.5:4b')).resolves.toEqual({
      supported: true,
    });
  });

  it('retries reachability before giving up', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"version":"0.21.0"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isOllamaReachable(undefined, { attempts: 2 })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('settles a retry delay immediately when its caller aborts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const controller = new AbortController();
    const result = isOllamaReachable(controller.signal, { attempts: 2 });

    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streams pull progress and reports percent complete', async () => {
    const progress: string[] = [];
    const percents: number[] = [];
    let tagCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
      if (url.includes('/api/pull')) {
        return Promise.resolve(
          ndjsonResponse([
            { status: 'pulling manifest' },
            { status: 'downloading', completed: 50, total: 100 },
            { status: 'success' },
          ]),
        );
      }
      if (url.includes('/api/tags')) {
        tagCalls += 1;
        if (tagCalls === 1) {
          return Promise.resolve(jsonResponse({ models: [] }));
        }
        return Promise.resolve(
          jsonResponse({ models: [{ name: 'llama3.2', size: 2_000_000_000 }] }),
        );
      }
      return Promise.resolve(jsonResponse({ models: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await pullOllamaModel('llama3.2', (event) => {
      progress.push(event.status);
      if (event.percent !== undefined) percents.push(event.percent);
    });

    expect(progress).toEqual(['pulling manifest', 'downloading', 'success']);
    expect(percents).toEqual([50]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/pull',
      expect.objectContaining({
        method: 'POST',
        // Origin is pinned to a loopback value so Ollama does not 403 the
        // packaged WebView's tauri://localhost origin.
        headers: { Origin: 'http://127.0.0.1:11434', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'llama3.2', stream: true }),
      }),
    );
  });

  it('skips pull when the model is already installed', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:latest' }] }));
      }
      return Promise.resolve(jsonResponse({ models: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const progress: string[] = [];
    await pullOllamaModel('llama3.2', (event) => progress.push(event.status));

    expect(progress).toEqual(['success']);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/pull'))).toBe(false);
  });

  it('force-pulls an installed model for repair or update', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'qwen3.5:4b' }] }));
      }
      if (url.includes('/api/pull')) {
        return Promise.resolve(ndjsonResponse([{ status: 'success' }]));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await pullOllamaModel('qwen3.5:4b', undefined, undefined, { force: true });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/pull'))).toBe(true);
  });

  it('removes a model and verifies that it is absent', async () => {
    let tagCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/delete')) {
        expect(init).toMatchObject({
          method: 'DELETE',
          body: JSON.stringify({ name: 'qwen3.5:4b' }),
        });
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url.includes('/api/tags')) {
        tagCalls += 1;
        return Promise.resolve(
          jsonResponse({
            models: tagCalls === 1 ? [{ name: 'qwen3.5:4b' }] : [],
          }),
        );
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(removeOllamaModel('qwen3.5:4b')).resolves.toBeUndefined();
  });

  it('verifies a real bounded local chat completion after installation', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (!url.includes('/api/chat')) return Promise.reject(new Error(`unexpected url ${url}`));
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'qwen3.5:4b',
        messages: [{ role: 'user', content: 'Reply with READY.' }],
        stream: false,
        think: false,
        keep_alive: 0,
        options: { temperature: 0, num_predict: 8 },
      });
      return Promise.resolve(
        jsonResponse({ message: { role: 'assistant', content: 'READY' }, done: true }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyOllamaModelChat('qwen3.5:4b')).resolves.toEqual({
      ok: true,
      response: 'READY',
    });
  });

  it('surfaces pull errors from Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/tags')) {
          return Promise.resolve(jsonResponse({ models: [] }));
        }
        return Promise.resolve(ndjsonResponse([{ error: 'model not found' }]));
      }),
    );

    await expect(pullOllamaModel('missing-model')).rejects.toThrow('model not found');
  });

  it('uses fast bounded chat options for local model responses', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/version')) {
        return Promise.resolve(new Response('{"version":"0.6.0"}', { status: 200 }));
      }
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:1b' }] }));
      }
      if (url.includes('/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        // Browser path uses OpenAI-compatible body (native path keeps Ollama options).
        expect(body.max_tokens).toBe(512);
        expect(typeof body.temperature).toBe('number');
        expect(Array.isArray(body.messages)).toBe(true);
        return Promise.resolve(
          sseResponse([
            { choices: [{ delta: { content: 'Done.' } }] },
            { choices: [{ finish_reason: 'stop' }] },
            '[DONE]',
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await ollamaProvider.run({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: 'Use real actions.',
        model: { provider: 'ollama', model: 'llama3.2:1b' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      messages: [{ role: 'user', content: 'open settings' }],
    });

    expect(response.text).toBe('Done.');
  });

  it('sends real image bytes on vision models and never reduces them to [Image:] text', () => {
    writeLocalAgentPreferences({ mode: 'fast', cloudEscalationEnabled: false });
    const multimodal = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'What is this?' },
          {
            type: 'image' as const,
            data: 'aW1hZ2UtYnl0ZXM=',
            mimeType: 'image/png',
            name: 'shot.png',
          },
        ],
      },
    ];
    const native = toOllamaNativeMessages(multimodal, { vision: true });
    expect(native[0]?.images).toEqual(['aW1hZ2UtYnl0ZXM=']);
    expect(native[0]?.content).toBe('What is this?');
    expect(JSON.stringify(native)).not.toMatch(/\[Image:/);

    const body = buildOllamaRequestBody(
      {
        agent: {
          id: 'agent_jarvis' as any,
          slug: 'jarvis',
          name: 'Jarvis',
          description: '',
          system_prompt: 'You are Jarvis.',
          model: { provider: 'ollama', model: 'llava:latest' },
          tools_allowed: [],
          memory_scope: 'workspace',
          capabilities: [],
          created_at: 1,
          updated_at: 1,
        },
        messages: multimodal,
      },
      'llava:latest',
    );
    const user = body.messages.find((message) => message.role === 'user');
    expect(user?.images).toEqual(['aW1hZ2UtYnl0ZXM=']);
    expect(JSON.stringify(body.messages)).not.toMatch(/\[Image:/);
    expect(body.vision).toBe(true);
  });

  it('keeps text-only local models honest by not shipping images[]', () => {
    const native = toOllamaNativeMessages(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'image', data: 'abc', mimeType: 'image/png', name: 'x.png' },
          ],
        },
      ],
      { vision: false },
    );
    expect(native[0]?.images).toBeUndefined();
    expect(native[0]?.content).toContain('[Image:');
  });

  it('returns native Ollama text through reliable Tauri IPC instead of event-only delivery', async () => {
    const nativeInvoke = vi
      .fn()
      .mockResolvedValue({ text: '  Hi.  ', inputTokens: 12, outputTokens: 2 });
    const response = await runNativeOllamaChat(nativeInvoke, {
      model: 'llama3.2:1b',
      messages: [{ role: 'user', content: 'Hi' }],
      options: { num_ctx: 4096 },
      think: false,
      baseUrl: 'http://127.0.0.1:11434',
    });

    expect(response).toEqual({ text: 'Hi.', inputTokens: 12, outputTokens: 2 });
    expect(nativeInvoke).toHaveBeenCalledWith(
      'ollama_chat',
      expect.objectContaining({
        model: 'llama3.2:1b',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    );
  });

  it('keeps an already-running desktop build working through the bounded legacy stream', async () => {
    let handler:
      | ((event: { payload: { delta: string; done: boolean; error?: string | null } }) => void)
      | undefined;
    const listen = async <T>(
      _event: string,
      next: (event: { payload: T }) => void,
    ): Promise<() => void> => {
      handler = next as unknown as typeof handler;
      return () => undefined;
    };
    const invokeCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      invokeCalls.push([command, args]);
      handler?.({ payload: { delta: 'Hi', done: false } });
      handler?.({ payload: { delta: ' there.', done: true } });
      return undefined as T;
    };

    await expect(
      runLegacyNativeOllamaChat(invoke, listen, {
        requestId: 'request-live-binary',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.45,
        baseUrl: 'http://127.0.0.1:11434',
        timeoutMs: 1_000,
      }),
    ).resolves.toBe('Hi there.');
    expect(invokeCalls).toEqual([
      [
        'ollama_chat_stream',
        expect.objectContaining({ requestId: 'request-live-binary', model: 'llama3.2:1b' }),
      ],
    ]);
  });

  it('streams native Ollama tokens progressively before completion', async () => {
    let handler:
      | ((event: { payload: { delta: string; done: boolean; error?: string | null } }) => void)
      | undefined;
    const listen = async <T>(
      _event: string,
      next: (event: { payload: T }) => void,
    ): Promise<() => void> => {
      handler = next as unknown as typeof handler;
      return () => undefined;
    };
    const invoke = async <T>(): Promise<T> => {
      handler?.({ payload: { delta: 'Hello', done: false } });
      handler?.({ payload: { delta: ' locally.', done: true } });
      return undefined as T;
    };
    const deltas: string[] = [];

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'progressive',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
        onDelta: (delta) => deltas.push(delta),
      }),
    ).resolves.toBe('Hello locally.');
    expect(deltas).toEqual(['Hello', ' locally.']);
  });

  it('uses the authoritative IPC result when WebView stream events are missed', async () => {
    const listen =
      async <T>(_event: string, _handler: (event: { payload: T }) => void): Promise<() => void> =>
      () =>
        undefined;
    const invoke = async <T>(): Promise<T> =>
      ({
        text: 'Delivered through IPC.',
        inputTokens: 4,
        outputTokens: 5,
      }) as T;

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'missed-webview-events',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
        firstResponseTimeoutMs: 10,
        maxAttempts: 1,
      }),
    ).resolves.toBe('Delivered through IPC.');
  });

  it('allows a cold local model more than 45 seconds to return its first authoritative result', async () => {
    vi.useFakeTimers();
    try {
      const listen =
        async <T>(_event: string, _handler: (event: { payload: T }) => void): Promise<() => void> =>
        () =>
          undefined;
      const invoke = async <T>(): Promise<T> =>
        new Promise<T>((resolve) => {
          window.setTimeout(
            () =>
              resolve({
                text: 'Cold model completed.',
                inputTokens: 4,
                outputTokens: 5,
              } as T),
            55_000,
          );
        });

      const response = runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'cold-model',
        model: 'llama3.2:latest',
        messages: [{ role: 'user', content: 'Explain this project.' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
        maxAttempts: 1,
      });
      const expectation = expect(response).resolves.toBe('Cold model completed.');

      await vi.advanceTimersByTimeAsync(55_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries one transient native transport failure only before output starts', async () => {
    let handler:
      | ((event: { payload: { delta: string; done: boolean; error?: string | null } }) => void)
      | undefined;
    const listen = async <T>(
      _event: string,
      next: (event: { payload: T }) => void,
    ): Promise<() => void> => {
      handler = next as unknown as typeof handler;
      return () => undefined;
    };
    let attempts = 0;
    const invoke = async <T>(): Promise<T> => {
      attempts += 1;
      if (attempts === 1) {
        handler?.({ payload: { delta: '', done: true, error: 'connect: reset' } });
      } else {
        handler?.({ payload: { delta: 'Recovered.', done: true } });
      }
      return undefined as T;
    };

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'retry',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).resolves.toBe('Recovered.');
    expect(attempts).toBe(2);
  });

  it('retries deep mode once without thinking when the installed model rejects think', async () => {
    let handler:
      | ((event: { payload: { delta: string; done: boolean; error?: string | null } }) => void)
      | undefined;
    const listen = async <T>(
      _event: string,
      next: (event: { payload: T }) => void,
    ): Promise<() => void> => {
      handler = next as unknown as typeof handler;
      return () => undefined;
    };
    const thinkValues: unknown[] = [];
    const invoke = async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
      thinkValues.push(args?.think);
      if (thinkValues.length === 1) {
        handler?.({
          payload: { delta: '', done: true, error: 'status_400: model does not support think' },
        });
      } else {
        handler?.({ payload: { delta: 'Supported.', done: true } });
      }
      return undefined as T;
    };

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'think-fallback',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: true,
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).resolves.toBe('Supported.');
    expect(thinkValues).toEqual([true, false]);
  });

  it('never retries after output starts or for deterministic provider errors', async () => {
    let handler:
      | ((event: { payload: { delta: string; done: boolean; error?: string | null } }) => void)
      | undefined;
    const listen = async <T>(
      _event: string,
      next: (event: { payload: T }) => void,
    ): Promise<() => void> => {
      handler = next as unknown as typeof handler;
      return () => undefined;
    };
    let attempts = 0;
    const invoke = async <T>(): Promise<T> => {
      attempts += 1;
      handler?.({ payload: { delta: 'Partial', done: false } });
      handler?.({ payload: { delta: '', done: true, error: 'connect: reset' } });
      return undefined as T;
    };

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'no-retry-after-output',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
      }),
    ).rejects.toThrow(/connect: reset/i);
    expect(attempts).toBe(1);
  });

  it('settles with an actionable first-response timeout instead of hanging', async () => {
    const listen =
      async <T>(_event: string, _next: (event: { payload: T }) => void): Promise<() => void> =>
      () =>
        undefined;
    const invoke = async <T>(): Promise<T> => new Promise<T>(() => undefined);

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'timeout',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
        firstResponseTimeoutMs: 10,
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/did not begin responding/i);
  });

  it('honors cancellation before starting native inference', async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn();
    const listen = vi.fn();

    await expect(
      runReliableNativeOllamaChat(invoke, listen, {
        requestId: 'cancelled',
        model: 'llama3.2:1b',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { num_ctx: 4096 },
        think: false,
        baseUrl: 'http://127.0.0.1:11434',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('enables bounded reasoning only in deep mode', () => {
    writeLocalAgentPreferences({ mode: 'deep', cloudEscalationEnabled: false });

    const body = buildOllamaRequestBody({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: '',
        model: { provider: 'ollama', model: 'qwen3.5:4b' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      messages: [{ role: 'user', content: 'Verify this plan.' }],
    });

    expect(body.think).toBe(true);
    expect(body.options.num_predict).toBe(2_048);
  });

  it('never lets an explicit per-turn budget exceed the bounded Ollama output cap', () => {
    const body = buildOllamaRequestBody({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: '',
        model: { provider: 'ollama', model: 'qwen3.5:4b' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      messages: [{ role: 'user', content: 'Hello.' }],
      max_output_tokens: 50_000,
    });

    expect(body.options.num_predict).toBe(8_192);
    expect(body.options.num_ctx).toBe(32_768);
  });

  it('honors distinct explicit token-mode budgets without changing the local default mode', () => {
    const agent = {
      id: 'agent_jarvis' as any,
      slug: 'jarvis',
      name: 'Jarvis',
      description: '',
      system_prompt: '',
      model: { provider: 'ollama', model: 'llama3.2:latest' },
      tools_allowed: [],
      memory_scope: 'workspace' as const,
      capabilities: [],
      created_at: 1,
      updated_at: 1,
    } satisfies Agent;

    const saver = buildOllamaRequestBody({
      agent,
      messages: [{ role: 'user', content: 'Answer concisely.' }],
      max_output_tokens: 512,
    });
    const normal = buildOllamaRequestBody({
      agent,
      messages: [{ role: 'user', content: 'Answer normally.' }],
      max_output_tokens: 2_000,
    });
    const finalBoss = buildOllamaRequestBody({
      agent,
      messages: [{ role: 'user', content: 'Plan, execute, and verify.' }],
      max_output_tokens: 8_192,
    });

    expect(saver.options.num_predict).toBe(512);
    expect(normal.options.num_predict).toBe(2_000);
    expect(finalBoss.options.num_predict).toBe(8_192);
    expect(saver.options.num_ctx).toBeLessThan(normal.options.num_ctx);
    expect(normal.options.num_ctx).toBeLessThan(finalBoss.options.num_ctx);
    expect(finalBoss.options.num_ctx).toBe(32_768);
  });

  it('sizes the context window from approved file history instead of output budget alone', () => {
    const body = buildOllamaRequestBody({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: '',
        model: { provider: 'ollama', model: 'llama3.2:latest' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      messages: [
        {
          role: 'assistant',
          content: `[BEGIN APPROVED FILE CONTENT]\n${'const shard = paragraph;\\n'.repeat(300)}[END APPROVED FILE CONTENT]`,
        },
        { role: 'user', content: 'Identify the bug in the approved code.' },
      ],
      max_output_tokens: 512,
    });

    expect(body.options.num_predict).toBe(512);
    expect(body.options.num_ctx).toBe(8_192);
  });

  it('sends the exact protected system prompt and observes body bytes before text', async () => {
    const controller = new AbortController();
    const order: string[] = [];
    let chatInit: RequestInit | undefined;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/version')) {
        return Promise.resolve(new Response('{"version":"0.6.0"}', { status: 200 }));
      }
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:1b' }] }));
      }
      if (url.includes('/v1/chat/completions')) {
        chatInit = init;
        return Promise.resolve(
          sseResponse([
            { choices: [{ delta: { content: 'Done.' } }] },
            { choices: [{ finish_reason: 'stop' }] },
            '[DONE]',
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await ollamaProvider.run({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: 'MUTABLE AGENT PROMPT MUST NOT BE SENT',
        model: { provider: 'ollama', model: 'llama3.2:1b' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      systemPrompt: 'EXACT PROTECTED SYSTEM CONTRACT',
      messages: [{ role: 'user', content: 'open settings' }],
      signal: controller.signal,
      onResponseObservation: (observation) => order.push(`observed:${observation.kind}`),
      onChunk: (chunk) => {
        if (chunk.delta) order.push(`chunk:${chunk.delta}`);
      },
    });

    const body = JSON.parse(String(chatInit?.body));
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'EXACT PROTECTED SYSTEM CONTRACT',
    });
    expect(JSON.stringify(body)).not.toContain('MUTABLE AGENT PROMPT MUST NOT BE SENT');
    expect(order[0]).toBe('observed:bytes');
    expect(response.text).toBe('Done.');
  });

  it('caps local chat history while preserving the latest user turn', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/version')) {
        return Promise.resolve(new Response('{"version":"0.6.0"}', { status: 200 }));
      }
      if (url.includes('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'llama3.2:1b' }] }));
      }
      if (url.includes('/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        expect(body.messages.length).toBeLessThanOrEqual(13);
        expect(body.messages.at(-1)).toMatchObject({
          role: 'user',
          content: 'latest command',
        });
        expect(JSON.stringify(body.messages)).not.toContain('old turn 1');
        return Promise.resolve(
          sseResponse([{ choices: [{ delta: { content: 'Done.' } }] }, '[DONE]']),
        );
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const longHistory = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `old turn ${index + 1}`,
    }));

    const response = await ollamaProvider.run({
      agent: {
        id: 'agent_jarvis' as any,
        slug: 'jarvis',
        name: 'Jarvis',
        description: '',
        system_prompt: 'Use real actions.',
        model: { provider: 'ollama', model: 'llama3.2:1b' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      messages: [...longHistory, { role: 'user', content: 'latest command' }],
    });

    expect(response.text).toBe('Done.');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    },
  );
}

function sseResponse(events: Array<unknown | '[DONE]'>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          const payload = event === '[DONE]' ? '[DONE]' : JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}
