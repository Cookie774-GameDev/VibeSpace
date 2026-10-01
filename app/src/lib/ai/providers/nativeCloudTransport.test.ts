import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { anthropicProvider } from './anthropic';
import { googleProvider } from './google';
import { groqProvider } from './groq';
import { openaiProvider } from './openai';

const nativeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nativeFetch', () => ({
  nativeFetch: nativeFetchMock,
}));

function streamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function request(provider: 'openai' | 'anthropic' | 'google' | 'groq') {
  return {
    agent: {
      id: `agent_${provider}` as never,
      slug: provider,
      name: provider,
      description: '',
      system_prompt: '',
      model: { provider, model: '' },
      tools_allowed: [],
      memory_scope: 'workspace' as const,
      capabilities: [],
      created_at: 1,
      updated_at: 1,
    },
    systemPrompt: 'Be concise.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    signal: new AbortController().signal,
    onChunk: vi.fn(),
  };
}

describe('first-party cloud provider transport', () => {
  afterEach(() => {
    nativeFetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    ['openai', openaiProvider, 'https://api.openai.com/v1/chat/completions', 'data: [DONE]\n\n'],
    [
      'anthropic',
      anthropicProvider,
      'https://api.anthropic.com/v1/messages',
      'event: message_stop\ndata: {}\n\n',
    ],
    [
      'google',
      googleProvider,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
      'data: {}\n\n',
    ],
    ['groq', groqProvider, 'https://api.groq.com/openai/v1/chat/completions', 'data: [DONE]\n\n'],
  ] as const)('%s never falls back to browser fetch', async (id, provider, url, body) => {
    useAuthStore.setState({ apiKeys: { [id]: `${id}-test-key` } });
    nativeFetchMock.mockResolvedValue(streamResponse(body));
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);

    await provider.run(request(id));

    expect(nativeFetchMock).toHaveBeenCalledWith(url, expect.any(Object));
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
