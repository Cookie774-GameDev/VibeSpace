import { afterEach, beforeEach, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { _resetNativeFetchForTests } from '@/lib/nativeFetch';
import { listOllamaModelInfo, pullOllamaModel, isOllamaReachable, ollamaProvider } from './ollama';

describe('ollama provider utilities', () => {
  beforeEach(() => {
    useAuthStore.setState({
      apiKeys: { ollama: 'http://127.0.0.1:11434' },
    });
    _resetNativeFetchForTests(null);
  });

  afterEach(() => {
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
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"version":"0.6.0"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isOllamaReachable()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
        expect(body.keep_alive).toBe('15m');
        expect(body.options).toMatchObject({
          num_ctx: 4096,
          num_predict: 320,
          repeat_penalty: 1.18,
          top_p: 0.9,
        });
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
