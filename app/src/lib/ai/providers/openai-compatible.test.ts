import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { openrouterProvider } from './compatibleInstances';
import {
  assertOpenRouterFreeImageOutputAvailable,
  makeOpenAICompatibleProvider,
} from './openai-compatible';

describe('makeOpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes id and name from config', () => {
    useAuthStore.setState({ apiKeys: {} });
    const p = makeOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyStoreKey: 'deepseek',
      defaultModel: 'deepseek-chat',
    });
    expect(p.id).toBe('deepseek');
    expect(p.name).toBe('DeepSeek');
    expect(p.isAvailable()).toBe(false);
  });

  it('sends the exact protected system prompt and observes body bytes before text', async () => {
    useAuthStore.setState({ apiKeys: { deepseek: 'test-key' } });
    const controller = new AbortController();
    const order: string[] = [];
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestInit = init;
      return sseResponse([
        { choices: [{ delta: { content: 'protected response' } }] },
        { choices: [{ finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = makeOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyStoreKey: 'deepseek',
      defaultModel: 'deepseek-chat',
    });

    const response = await provider.run({
      agent: {
        id: 'agent_test' as any,
        slug: 'test',
        name: 'Test',
        description: '',
        system_prompt: 'MUTABLE AGENT PROMPT MUST NOT BE SENT',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      systemPrompt: 'EXACT PROTECTED SYSTEM CONTRACT',
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
      onResponseObservation: (observation) => order.push(`observed:${observation.kind}`),
      onChunk: (chunk) => {
        if (chunk.delta) order.push(`chunk:${chunk.delta}`);
      },
    });

    const body = JSON.parse(String(requestInit?.body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'EXACT PROTECTED SYSTEM CONTRACT' },
      { role: 'user', content: 'hello' },
    ]);
    expect(JSON.stringify(body)).not.toContain('MUTABLE AGENT PROMPT MUST NOT BE SENT');
    expect(requestInit?.signal).toBe(controller.signal);
    expect(order[0]).toBe('observed:bytes');
    expect(response.text).toBe('protected response');
    expect(response.usage.provenance).toBe('estimated');
  });
});

describe('OpenRouter image output', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preflights the authenticated account catalog and projects bounded data images', async () => {
    useAuthStore.setState({ apiKeys: { openrouter: 'test-openrouter-key' } });
    const requestBodies: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestBodies.push({ url, init });
      if (url.endsWith('/models/user')) {
        return jsonResponse({ data: [freeOpenRouterImageModel()] });
      }
      if (url.endsWith('/chat/completions')) {
        return jsonResponse({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'A blue bird',
                images: [
                  {
                    type: 'image_url',
                    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 7 },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const observations: string[] = [];
    const onActionDispatch = vi.fn();
    const response = await makeOpenRouterProvider().run(
      openRouterImageRequest({
        onActionDispatch,
        onChunk: (chunk) => chunks.push(chunk.delta),
        onResponseObservation: (observation) => observations.push(observation.kind),
      }),
    );

    expect(requestBodies.map(({ url }) => url)).toEqual([
      'https://openrouter.ai/api/v1/models/user',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    const [catalogRequest, inferenceRequest] = requestBodies;
    expect(catalogRequest?.init?.headers).toEqual({
      Authorization: 'Bearer test-openrouter-key',
    });
    const body = JSON.parse(String(inferenceRequest?.init?.body));
    expect(body).toMatchObject({
      model: 'google/test-image-model',
      stream: false,
      modalities: ['text', 'image'],
    });
    expect(JSON.stringify(body)).not.toContain('test-openrouter-key');
    expect(response).toMatchObject({
      text: 'A blue bird',
      finish_reason: 'stop',
      usage: { input_tokens: 4, output_tokens: 7, cost_usd: 0 },
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    expect(chunks).toEqual(['A blue bird', '']);
    expect(observations).toContain('bytes');
    expect(onActionDispatch).toHaveBeenCalledTimes(1);
    expect(onActionDispatch).toHaveBeenCalledWith({ observedAt: expect.any(Number) });
  });

  it('does not start inference when live model pricing is nonzero', async () => {
    useAuthStore.setState({ apiKeys: { openrouter: 'test-openrouter-key' } });
    const onActionDispatch = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            ...freeOpenRouterImageModel(),
            pricing: { prompt: '0.000001', completion: '0', image: '0', request: '0' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeOpenRouterProvider().run(openRouterImageRequest({ onActionDispatch })),
    ).rejects.toThrow(/explicitly zero-priced image output/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onActionDispatch).not.toHaveBeenCalled();
  });

  it('fails closed when image pricing is missing from the account catalog', async () => {
    useAuthStore.setState({ apiKeys: { openrouter: 'test-openrouter-key' } });
    const onActionDispatch = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            ...freeOpenRouterImageModel(),
            pricing: { prompt: '0', completion: '0', request: '0' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeOpenRouterProvider().run(openRouterImageRequest({ onActionDispatch })),
    ).rejects.toThrow(/explicitly zero-priced image output/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onActionDispatch).not.toHaveBeenCalled();
  });

  it('rejects remote, unsupported, and malformed image URLs without echoing them', async () => {
    useAuthStore.setState({ apiKeys: { openrouter: 'test-openrouter-key' } });
    const privateUrl = 'https://private.example/secret-image.png?token=never-log-this';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [freeOpenRouterImageModel()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'Generated',
                images: [{ image_url: { url: privateUrl } }],
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const errorMessage = await makeOpenRouterProvider()
      .run(openRouterImageRequest())
      .then(() => '', (value: unknown) => (value instanceof Error ? value.message : String(value)));

    expect(errorMessage).toMatch(/unsupported image output/i);
    expect(errorMessage).not.toContain(privateUrl);
    expect(errorMessage).not.toContain('never-log-this');
  });

  it('rejects image data above the shared 8 MiB attachment limit', async () => {
    useAuthStore.setState({ apiKeys: { openrouter: 'test-openrouter-key' } });
    const tooLargeData = 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [freeOpenRouterImageModel()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                images: [{ image_url: { url: `data:image/png;base64,${tooLargeData}` } }],
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeOpenRouterProvider().run(openRouterImageRequest())).rejects.toThrow(
      /supported size limit/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails preflight before network access when no OpenRouter key is configured', async () => {
    useAuthStore.setState({ apiKeys: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertOpenRouterFreeImageOutputAvailable('google/test-image-model')).rejects.toThrow(
      /OpenRouter API key.*Settings/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function sseResponse(records: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) {
          const data = record === '[DONE]' ? record : JSON.stringify(record);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function makeOpenRouterProvider() {
  return openrouterProvider;
}

function openRouterImageRequest(
  overrides: Partial<Parameters<ReturnType<typeof makeOpenRouterProvider>['run']>[0]> = {},
) {
  return {
    agent: {
      id: 'agent_image_test' as any,
      slug: 'image-test',
      name: 'Image test',
      description: '',
      system_prompt: '',
      model: { provider: 'openrouter', model: 'google/test-image-model' },
      tools_allowed: [],
      memory_scope: 'workspace',
      capabilities: [],
      created_at: 1,
      updated_at: 1,
    },
    messages: [{ role: 'user' as const, content: 'Draw a blue bird' }],
    imageOutputRequested: true,
    ...overrides,
  } as Parameters<ReturnType<typeof makeOpenRouterProvider>['run']>[0];
}

function freeOpenRouterImageModel() {
  return {
    id: 'google/test-image-model',
    architecture: { output_modalities: ['text', 'image'] },
    pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
