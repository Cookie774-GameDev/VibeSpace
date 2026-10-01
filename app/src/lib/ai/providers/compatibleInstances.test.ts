import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import {
  probeQwenApiCredential,
  resetActiveQwenCompatibleBaseUrlForTests,
} from '../nativeConnectionProbe';
import {
  deepseekProvider,
  mistralProvider,
  openrouterProvider,
  QWEN_DEFAULT_MODEL,
  qwenProvider,
  togetherProvider,
  xaiProvider,
} from './compatibleInstances';

const nativeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nativeFetch', () => ({
  nativeFetch: nativeFetchMock,
}));

describe('Qwen compatible provider', () => {
  beforeEach(async () => {
    resetActiveQwenCompatibleBaseUrlForTests();
    await probeQwenApiCredential(
      'verified-test-key',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).startsWith('https://dashscope-us.aliyuncs.com/')
          ? new Response('{}', { status: 200 })
          : new Response('', { status: 401 }),
      ),
    );
  });

  afterEach(() => {
    nativeFetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fails closed before transport when no bounded endpoint authenticated successfully', async () => {
    resetActiveQwenCompatibleBaseUrlForTests();
    useAuthStore.setState({ apiKeys: { qwen: 'qwen-test-key' } });

    await expect(
      qwenProvider.run({
        agent: {
          id: 'agent_qwen_unverified' as never,
          slug: 'qwen',
          name: 'Qwen',
          description: '',
          system_prompt: '',
          model: { provider: 'qwen', model: QWEN_DEFAULT_MODEL },
          tools_allowed: [],
          memory_scope: 'workspace',
          capabilities: [],
          created_at: 1,
          updated_at: 1,
        },
        systemPrompt: 'Be concise.',
        messages: [{ role: 'user', content: 'Hello' }],
        signal: new AbortController().signal,
        onChunk: vi.fn(),
      }),
    ).rejects.toThrow('authenticated endpoint');
    expect(nativeFetchMock).not.toHaveBeenCalled();
  });

  it('streams chat through the official Model Studio US endpoint', async () => {
    useAuthStore.setState({ apiKeys: { qwen: 'qwen-test-key' } });
    let requestInit: RequestInit | undefined;
    nativeFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      requestInit = init;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Qwen ready' } }] })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await qwenProvider.run({
      agent: {
        id: 'agent_qwen' as never,
        slug: 'qwen',
        name: 'Qwen',
        description: '',
        system_prompt: '',
        model: { provider: 'qwen', model: QWEN_DEFAULT_MODEL },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      systemPrompt: 'Be concise.',
      messages: [{ role: 'user', content: 'Hello' }],
      signal: new AbortController().signal,
      onChunk: vi.fn(),
    });

    expect(nativeFetchMock.mock.calls[0]?.[0]).toBe(
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer qwen-test-key');
    expect(JSON.parse(String(requestInit?.body)).model).toBe('qwen3.7-plus');
    expect(response.text).toBe('Qwen ready');
  });

  it.each([
    ['openrouter', openrouterProvider, 'https://openrouter.ai/api/v1/chat/completions'],
    ['deepseek', deepseekProvider, 'https://api.deepseek.com/chat/completions'],
    ['mistral', mistralProvider, 'https://api.mistral.ai/v1/chat/completions'],
    ['together', togetherProvider, 'https://api.together.xyz/v1/chat/completions'],
    ['xai', xaiProvider, 'https://api.x.ai/v1/chat/completions'],
    ['qwen', qwenProvider, 'https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions'],
  ] as const)('%s streams through the packaged-app native transport', async (id, provider, url) => {
    useAuthStore.setState({ apiKeys: { [id]: `${id}-test-key` } });
    nativeFetchMock.mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);

    await provider.run({
      agent: {
        id: `agent_${id}` as never,
        slug: id,
        name: id,
        description: '',
        system_prompt: '',
        model: { provider: id, model: '' },
        tools_allowed: [],
        memory_scope: 'workspace',
        capabilities: [],
        created_at: 1,
        updated_at: 1,
      },
      systemPrompt: 'Be concise.',
      messages: [{ role: 'user', content: 'Hello' }],
      signal: new AbortController().signal,
      onChunk: vi.fn(),
    });

    expect(nativeFetchMock).toHaveBeenCalledWith(url, expect.any(Object));
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
