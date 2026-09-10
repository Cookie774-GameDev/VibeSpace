import { describe, expect, it, vi } from 'vitest';
import {
  nativeCodexFrames,
  startNativeCodexAppServer,
  stopNativeCodexAppServer,
  writeNativeCodexFrame,
} from './codexNativeTransport';

describe('native Codex app-server transport', () => {
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
});
