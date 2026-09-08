import { describe, expect, it, vi } from 'vitest';
import { nativeCodexFrames } from './codexNativeTransport';

describe('native Codex subscription acknowledgement', () => {
  it('does not authorize writes until native registration succeeds', async () => {
    let acknowledge!: () => void;
    let send!: (message: unknown) => void;
    const registered = new Promise<void>((resolve) => { acknowledge = resolve; });
    const subscribed = vi.fn();
    const invoke = vi.fn(() => registered);
    const frames = nativeCodexFrames('generation-1', undefined, async () => ({
      invoke,
      channel: (handler) => { send = handler; return { onmessage: handler }; },
    }), subscribed);
    const next = frames.next();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(subscribed).not.toHaveBeenCalled();
    acknowledge();
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
    send({ kind: 'done' });
    expect((await next).done).toBe(true);
  });

  it('does not authorize writes when native registration fails', async () => {
    const subscribed = vi.fn();
    const frames = nativeCodexFrames('generation-1', undefined, async () => ({
      invoke: async () => { throw new Error('registration rejected'); },
      channel: (handler) => ({ onmessage: handler }),
    }), subscribed);
    await expect(frames.next()).rejects.toThrow('registration rejected');
    expect(subscribed).not.toHaveBeenCalled();
  });
});
