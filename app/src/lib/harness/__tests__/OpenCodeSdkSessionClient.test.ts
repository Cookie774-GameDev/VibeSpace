import { describe, expect, it, vi } from 'vitest';
import {
  CatalogVariantPromptAdapter,
  OpenCodeSdkSessionClient,
  type ModelControlPromptAdapter,
  type OpenCodeRawEvent,
} from '../OpenCodeSdkSessionClient';

function asyncEvents(events: readonly OpenCodeRawEvent[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function fakeClient(events: readonly OpenCodeRawEvent[] = []) {
  return {
    global: { health: vi.fn(async () => ({ data: { healthy: true, version: '1.2.3' } })) },
    config: { providers: vi.fn(async () => ({ data: { providers: [] } })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'session-1' } })),
      get: vi.fn(async () => ({ data: { id: 'session-1' } })),
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
    },
    event: { subscribe: vi.fn(async () => ({ stream: asyncEvents(events) })) },
  };
}

describe('OpenCodeSdkSessionClient', () => {
  it('uses async prompt on one persistent client with exact model identity', async () => {
    const client = fakeClient();
    const adapter: ModelControlPromptAdapter = {
      toPromptFields: () => ({ variant: 'max-fast' }),
    };
    const sdk = new OpenCodeSdkSessionClient(client, adapter);
    await sdk.sendAsync({
      sessionId: 'session-1',
      controls: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'max-fast',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'hello',
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        variant: 'max-fast',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });
  });

  it('maps exact live effort/Fast metadata to a named OpenCode variant', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(
      client,
      new CatalogVariantPromptAdapter(() => ({
        effortVariants: { high: 'high' },
        fastVariant: 'fast',
        combinedVariants: { 'high+fast': 'high-fast' },
      })),
    );
    await sdk.sendAsync({
      sessionId: 'session-1',
      controls: {
        connectionId: 'openai-chatgpt-pro', providerId: 'openai', modelId: 'gpt-5.6-sol',
        effort: 'high', serviceTier: 'fast', performance: 'quality', rlmEnabled: true,
      },
      text: 'hello',
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ variant: 'high-fast' }),
    }));
  });

  it('refuses blocking/per-turn fallback when promptAsync is unavailable', async () => {
    const client = fakeClient();
    delete (client.session as { promptAsync?: unknown }).promptAsync;
    const sdk = new OpenCodeSdkSessionClient(client);
    await expect(
      sdk.sendAsync({
        sessionId: 's',
        controls: {
          connectionId: 'c', providerId: 'openai', modelId: 'm', performance: 'quality', rlmEnabled: true,
        },
        text: 'hello',
      }),
    ).rejects.toThrow(/refusing per-turn CLI fallback/u);
  });

  it('fails closed when independent effort transport is not version-adapted', async () => {
    const sdk = new OpenCodeSdkSessionClient(fakeClient());
    await expect(
      sdk.sendAsync({
        sessionId: 's',
        controls: {
          connectionId: 'c', providerId: 'openai', modelId: 'm', effort: 'max', performance: 'quality', rlmEnabled: true,
        },
        text: 'hello',
      }),
    ).rejects.toThrow(/cannot transport independent effort/u);
  });

  it('reconstructs snapshot-only text events and filters another session', async () => {
    const client = fakeClient([
      { type: 'message.part.updated', properties: { part: { id: 'p', sessionID: 'other', type: 'text', text: 'wrong' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p', sessionID: 'session-1', type: 'text', text: 'Hello' } } },
      { type: 'message.part.updated', properties: { part: { id: 'p', sessionID: 'session-1', type: 'text', text: 'Hello world' } } },
    ]);
    const sdk = new OpenCodeSdkSessionClient(client);
    const emissions = [];
    for await (const emission of sdk.subscribeTextEvents({ sessionId: 'session-1' })) {
      emissions.push(emission);
    }
    expect(emissions.map((event) => event.kind === 'delta' ? event.text : event.fullText)).toEqual([
      'Hello', ' world',
    ]);
  });
});
