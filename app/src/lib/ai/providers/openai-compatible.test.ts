import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { makeOpenAICompatibleProvider } from './openai-compatible';

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
