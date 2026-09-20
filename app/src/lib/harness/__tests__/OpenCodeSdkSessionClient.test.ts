import { describe, expect, it, vi } from 'vitest';
import {
  CatalogVariantPromptAdapter,
  OpenCodeSdkSessionClient,
  StrictModelControlPromptAdapter,
  toProviderSafeOpenCodeTools,
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
    command: {
      list: vi.fn(async () => ({ data: [{ name: 'goal', source: 'command' }] })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: 'session-1' } })),
      get: vi.fn(async () => ({ data: { id: 'session-1' } })),
      update: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      command: vi.fn(async () => ({ data: { info: { id: 'message-1' }, parts: [] } })),
    },
    event: { subscribe: vi.fn(async () => ({ stream: asyncEvents(events) })) },
  };
}

describe('OpenCodeSdkSessionClient', () => {
  it('binds the predeclared execution agent in the prompt without unsupported session mutation', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);

    await sdk.sendAsync({
      sessionId: 'session-1',
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openai',
        modelId: 'gpt-5.6-luna-fast',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'build the fixture',
      agent: 'vibespace-full',
    });

    expect(client.session.update).not.toHaveBeenCalled();
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: expect.objectContaining({ agent: 'vibespace-full' }),
    });
  });

  it('fails closed before prompt when no execution agent is bound', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);

    await expect(
      sdk.sendAsync({
        sessionId: 'session-1',
        agent: undefined as never,
        controls: {
          connectionId: 'opencode-cli',
          providerId: 'openai',
          modelId: 'gpt-5.6-luna-fast',
          performance: 'quality',
          rlmEnabled: true,
        },
        text: 'build the fixture',
      }),
    ).rejects.toThrow('execution agent');
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('uses provider-safe wire names without changing semantic gateway identity', async () => {
    expect(
      toProviderSafeOpenCodeTools({
        'terminal.list': true,
        'app.getState': false,
        vibespace_context: true,
      }),
    ).toEqual({ terminal_list: true, app_getState: false, vibespace_context: true });

    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);
    await sdk.sendAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4-flash-vision-exp',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'hello',
      tools: { 'terminal.list': false, vibespace_context: true },
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          tools: { terminal_list: false, vibespace_context: true },
        }),
      }),
    );
  });

  it('uses async prompt on one persistent client with exact model identity', async () => {
    const client = fakeClient();
    const adapter: ModelControlPromptAdapter = {
      toPromptFields: () => ({ variant: 'max-fast' }),
    };
    const sdk = new OpenCodeSdkSessionClient(client, adapter);
    await sdk.sendAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
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
        agent: 'vibespace-full',
        parts: [{ type: 'text', text: 'hello' }],
      },
    });
  });

  it('executes only the actual registered OpenCode goal command with exact model controls', async () => {
    const client = fakeClient();
    const adapter: ModelControlPromptAdapter = {
      toPromptFields: () => ({ variant: 'max-fast' }),
    };
    const sdk = new OpenCodeSdkSessionClient(client, adapter);
    await sdk.sendCommandAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'max-fast',
        performance: 'quality',
        rlmEnabled: true,
      },
      command: 'goal',
      arguments: 'Finish the focused native verification',
    });

    expect(client.command.list).toHaveBeenCalledOnce();
    expect(client.session.command).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        command: 'goal',
        arguments: 'Finish the focused native verification',
        agent: 'vibespace-full',
        model: 'openai/gpt-5.6-sol',
        variant: 'max-fast',
      },
    });
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it.each(['init', 'my_command'])('dispatches registered /%s with an empty argument string', async (command) => {
    const client = fakeClient();
    client.command.list.mockResolvedValueOnce({ data: [{ name: command, source: 'command' }] });
    const sdk = new OpenCodeSdkSessionClient(client);

    await sdk.sendCommandAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        performance: 'quality',
        rlmEnabled: true,
      },
      command,
      arguments: '',
    });

    expect(client.session.command).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ command, arguments: '' }),
    }));
  });

  it('does not double-qualify a federated route on the command endpoint', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);

    await sdk.sendCommandAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'opencode',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        performance: 'quality',
        rlmEnabled: true,
      },
      command: 'goal',
      arguments: 'Finish the route check',
    });

    expect(client.session.command).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        model: 'opencode-go/deepseek-v4-flash-vision-exp',
      }),
    }));
  });

  it('retains an explicit provider for nested upstream model IDs', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);

    await sdk.sendAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'openrouter',
        modelId: 'openai/gpt-5.6-luna',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'hello',
    });

    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        model: {
          providerID: 'openrouter',
          modelID: 'openai/gpt-5.6-luna',
        },
      }),
    }));
  });

  it('splits qualified federated routes once for prompt_async', async () => {
    const client = fakeClient();
    const sdk = new OpenCodeSdkSessionClient(client);

    await sdk.sendAsync({
      sessionId: 'session-1',
      agent: 'vibespace-full',
      controls: {
        connectionId: 'opencode-cli',
        providerId: 'opencode',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'hello',
    });

    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        model: {
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash-vision-exp',
        },
      }),
    }));
  });

  it('fails closed when goal is not in the live OpenCode command catalog', async () => {
    const client = fakeClient();
    client.command.list.mockResolvedValueOnce({ data: [{ name: 'review', source: 'command' }] });
    const sdk = new OpenCodeSdkSessionClient(client);
    await expect(
      sdk.sendCommandAsync({
        sessionId: 'session-1',
        agent: 'vibespace-full',
        controls: {
          connectionId: 'opencode-cli',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          performance: 'quality',
          rlmEnabled: true,
        },
        command: 'goal',
        arguments: 'Do the work',
      }),
    ).rejects.toThrow(/not registered/u);
    expect(client.session.command).not.toHaveBeenCalled();
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
      agent: 'vibespace-full-auto',
      controls: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        effort: 'high',
        serviceTier: 'fast',
        performance: 'quality',
        rlmEnabled: true,
      },
      text: 'hello',
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ variant: 'high-fast' }),
      }),
    );
  });

  it('combines an already-resolved effort variant with Fast only through exact live metadata', () => {
    const adapter = new CatalogVariantPromptAdapter(() => ({
      effortVariants: { max: 'max' },
      combinedVariants: { 'max+fast': 'max-fast' },
    }));

    expect(
      adapter.toPromptFields({
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'max',
        serviceTier: 'fast',
        performance: 'quality',
        rlmEnabled: true,
      }),
    ).toEqual({ variant: 'max-fast' });
  });

  it('fails closed instead of silently dropping Fast from an effort variant', () => {
    const adapter = new CatalogVariantPromptAdapter(() => ({
      effortVariants: { max: 'max' },
    }));

    expect(() =>
      adapter.toPromptFields({
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        variant: 'max',
        serviceTier: 'fast',
        performance: 'quality',
        rlmEnabled: true,
      }),
    ).toThrow(/combined max\+fast variant/u);
  });

  it('fails closed when the strict transport cannot carry native OpenCode Fast', () => {
    expect(() =>
      new StrictModelControlPromptAdapter().toPromptFields({
        connectionId: 'opencode-cli',
        providerId: 'opencode-go',
        modelId: 'model',
        variant: 'max',
        openCodeFastMode: true,
        performance: 'quality',
        rlmEnabled: true,
      }),
    ).toThrow(/HARNESS_INCOMPATIBLE/u);
  });

  it('refuses blocking/per-turn fallback when promptAsync is unavailable', async () => {
    const client = fakeClient();
    delete (client.session as { promptAsync?: unknown }).promptAsync;
    const sdk = new OpenCodeSdkSessionClient(client);
    await expect(
      sdk.sendAsync({
        sessionId: 's',
        agent: 'vibespace-readonly',
        controls: {
          connectionId: 'c',
          providerId: 'openai',
          modelId: 'm',
          performance: 'quality',
          rlmEnabled: true,
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
        agent: 'vibespace-readonly',
        controls: {
          connectionId: 'c',
          providerId: 'openai',
          modelId: 'm',
          effort: 'max',
          performance: 'quality',
          rlmEnabled: true,
        },
        text: 'hello',
      }),
    ).rejects.toThrow(/cannot transport independent effort/u);
  });

  it('reconstructs snapshot-only text events and filters another session', async () => {
    const client = fakeClient([
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p', sessionID: 'other', type: 'text', text: 'wrong' } },
      },
      {
        type: 'message.part.updated',
        properties: { part: { id: 'p', sessionID: 'session-1', type: 'text', text: 'Hello' } },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p', sessionID: 'session-1', type: 'text', text: 'Hello world' },
        },
      },
    ]);
    const sdk = new OpenCodeSdkSessionClient(client);
    const emissions = [];
    for await (const emission of sdk.subscribeTextEvents({ sessionId: 'session-1' })) {
      emissions.push(emission);
    }
    expect(
      emissions.map((event) => (event.kind === 'delta' ? event.text : event.fullText)),
    ).toEqual(['Hello', ' world']);
  });
});
