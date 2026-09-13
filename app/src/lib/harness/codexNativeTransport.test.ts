import { describe, expect, it, vi } from 'vitest';
import {
  nativeCodexFrames,
  startNativeCodexAppServer,
  stopNativeCodexAppServer,
  writeNativeCodexFrame,
} from './codexNativeTransport';

describe('native Codex app-server transport', () => {
  it('retains burst command output in order without overflowing the event queue', async () => {
    let receive!: (value: unknown) => void;
    const chunks = Array.from({ length: 257 }, (_, index) => `line ${index}\n`);
    const bridge = async () => ({
      invoke: vi.fn(async (command: string) => {
        if (command !== 'codex_app_server_stream') return;
        for (const delta of chunks)
          receive({
            kind: 'frame',
            frame: {
              method: 'item/commandExecution/outputDelta',
              params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', delta },
            },
          });
        receive({
          kind: 'frame',
          frame: { method: 'item/completed', params: { itemId: 'command-1' } },
        });
        receive({ kind: 'done' });
      }),
      channel: (handler: (value: unknown) => void) => {
        receive = handler;
        return { onmessage: handler };
      },
    });
    const frames = [];
    for await (const frame of nativeCodexFrames('burst-generation', undefined, bridge))
      frames.push(frame);
    expect(frames).toEqual([
      {
        method: 'item/commandExecution/outputDelta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'command-1',
          delta: chunks.join(''),
        },
      },
      { method: 'item/completed', params: { itemId: 'command-1' } },
    ]);
  });

  it('never merges command output across an item, turn, control event, or size boundary', async () => {
    let receive!: (value: unknown) => void;
    const output = (delta: string, itemId = 'command-1', turnId = 'turn-1') => ({
      method: 'item/commandExecution/outputDelta',
      params: { threadId: 'thread-1', turnId, itemId, delta },
    });
    const expected = [
      output('a'),
      output('b', 'command-2'),
      output('c', 'command-2', 'turn-2'),
      { method: 'turn/completed', params: { turnId: 'turn-2' } },
      output('x'.repeat(32768)),
      output('tail'),
    ];
    const bridge = async () => ({
      invoke: vi.fn(async (command: string) => {
        if (command !== 'codex_app_server_stream') return;
        for (const frame of expected) receive({ kind: 'frame', frame });
        receive({ kind: 'done' });
      }),
      channel: (handler: (value: unknown) => void) => {
        receive = handler;
        return { onmessage: handler };
      },
    });
    const frames = [];
    for await (const frame of nativeCodexFrames('barrier-generation', undefined, bridge))
      frames.push(frame);
    expect(frames).toEqual(expected);
  });

  it('does not subscribe after cancellation while loading the bridge', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => undefined);
    const bridge = async () => {
      controller.abort();
      return { invoke, channel: vi.fn() as never };
    };
    const stream = nativeCodexFrames('codex-generation-1', controller.signal, bridge);
    const outcome = await Promise.race([
      stream.next().then((value) => (value.done ? 'closed' : 'frame')),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 100)),
    ]);
    expect(outcome).toBe('closed');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves native startup failure guidance as a bounded Error', async () => {
    const bridge = async () => ({
      invoke: async () => {
        throw 'OpenCodex did not prove readiness.\nRetry startup.';
      },
      channel: vi.fn() as never,
    });
    await expect(
      startNativeCodexAppServer(
        'trusted-codex-1',
        'chat-1',
        'opencode-go/deepseek-v4-flash-vision-exp',
        bridge,
      ),
    ).rejects.toEqual(new Error('OpenCodex did not prove readiness. Retry startup.'));
  });

  it('starts only an existing trusted executable identity and returns an opaque generation', async () => {
    const invoke = vi.fn(async () => ({ generation: 'codex-generation-1' }));
    const result = await startNativeCodexAppServer(
      'trusted-codex-1',
      'chat-1',
      'opencode-go/deepseek-v4-flash-vision-exp',
      async () => ({
        invoke,
        channel: vi.fn() as never,
      }),
    );

    expect(result).toEqual({ generation: 'codex-generation-1' });
    expect(invoke).toHaveBeenCalledWith('codex_app_server_start', {
      request: {
        executableId: 'trusted-codex-1',
        ownerId: 'chat-1',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      },
    });
  });

  it('subscribes through a bounded channel and yields exact decoded object frames', async () => {
    let onmessage: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'codex_app_server_stream') {
        queueMicrotask(() => {
          onmessage?.({ kind: 'frame', frame: { method: 'turn/started', params: {} } });
          onmessage?.({ kind: 'done' });
        });
      }
    });
    const bridge = async () => ({
      invoke,
      channel: (handler: (value: unknown) => void) => {
        onmessage = handler;
        return { onmessage: handler };
      },
    });

    const frames = [];
    for await (const frame of nativeCodexFrames('codex-generation-1', undefined, bridge)) {
      frames.push(frame);
    }

    expect(frames).toEqual([{ method: 'turn/started', params: {} }]);
    expect(invoke).toHaveBeenCalledWith('codex_app_server_stream', {
      generation: 'codex-generation-1',
      streamId: expect.stringMatching(/^codex-stream-[a-f0-9]+$/u),
      onEvent: expect.any(Object),
    });
  });

  it('writes only bounded JSON objects and stops the exact generation', async () => {
    const invoke = vi.fn(async (command: string) => command === 'codex_app_server_stop');
    const bridge = async () => ({ invoke, channel: vi.fn() as never });

    await writeNativeCodexFrame(
      'codex-generation-1',
      { id: 'turn-1', method: 'turn/start', params: {} },
      bridge,
    );
    await expect(
      writeNativeCodexFrame('codex-generation-1', ['not-an-object'], bridge),
    ).rejects.toThrow(/object/u);
    expect(await stopNativeCodexAppServer('codex-generation-1', bridge)).toBe(true);

    expect(invoke).toHaveBeenCalledWith('codex_app_server_write', {
      generation: 'codex-generation-1',
      message: { id: 'turn-1', method: 'turn/start', params: {} },
    });
    expect(invoke).toHaveBeenCalledWith('codex_app_server_stop', {
      generation: 'codex-generation-1',
    });
  });

  it('fails closed when the renderer queue exceeds its event bound', async () => {
    let onmessage: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'codex_app_server_stream') {
        for (let index = 0; index < 257; index += 1) {
          onmessage?.({ kind: 'frame', frame: { method: 'ping', params: { index } } });
        }
      }
    });
    const bridge = async () => ({
      invoke,
      channel: (handler: (value: unknown) => void) => {
        onmessage = handler;
        return { onmessage: handler };
      },
    });

    const consume = async () => {
      for await (const _frame of nativeCodexFrames('codex-generation-1', undefined, bridge)) {
        // The native producer fills this synchronously before the first consumer step.
      }
    };

    await expect(consume()).rejects.toThrow(/queue exceeded safe limits/u);
    expect(invoke).toHaveBeenCalledWith('codex_app_server_stop', {
      generation: 'codex-generation-1',
    });
  });
  it.each(['channel', 'registration'] as const)(
    'closes when cancellation races %s setup',
    async (phase) => {
      const controller = new AbortController();
      let receive!: (value: unknown) => void;
      const invoke = vi.fn(async (command: string) => {
        if (command === 'codex_app_server_stream' && phase === 'registration') controller.abort();
      });
      const bridge = async () => ({
        invoke,
        channel: (handler: (value: unknown) => void) => {
          receive = handler;
          if (phase === 'channel') controller.abort();
          return { onmessage: handler };
        },
      });
      const stream = nativeCodexFrames('codex-race-generation', controller.signal, bridge);
      const next = stream.next();
      const outcome = await Promise.race([
        next.then((result) => (result.done ? 'closed' : 'frame')),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      // Settle the unfixed reader as well, so a failed assertion leaks no test work.
      if (outcome === 'pending') {
        receive({ kind: 'done' });
        await next;
      }
      expect(outcome).toBe('closed');
      expect(
        invoke.mock.calls.filter(([command]) => command === 'codex_app_server_stop'),
      ).toHaveLength(1);
    },
  );

  it('shares one exact-generation stop between cancellation and final cleanup', async () => {
    const controller = new AbortController();
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const invoke = vi.fn(async () => undefined);
    const bridge = async () => ({
      invoke,
      channel: (onmessage: (value: unknown) => void) => ({ onmessage }),
    });
    const stream = nativeCodexFrames(
      'codex-owned-generation',
      controller.signal,
      bridge,
      registered,
    );
    const next = stream.next();
    await ready;
    controller.abort();
    expect((await next).done).toBe(true);
    const stops = invoke.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    expect(stops.filter(([command]) => command === 'codex_app_server_stop')).toEqual([
      ['codex_app_server_stop', { generation: 'codex-owned-generation' }],
    ]);
  });
});
