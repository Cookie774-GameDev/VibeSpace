// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual generated native plugin function, without a browser or network.
const source = readFileSync('src-tauri/src/harness/server.rs', 'utf8');
const callSource = source.slice(
  source.indexOf('async function call(name, args, context)'),
  source.indexOf('const define = (name, description, args)'),
);

function fixture(body = '{"ok":true}') {
  const timeout = vi.fn(() => new AbortController().signal);
  const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => body });
  const call = runInNewContext(`(${callSource})`, {
    process: {
      env: {
        VIBESPACE_TOOL_GATEWAY_URL: 'http://127.0.0.1:4567/v1/tool',
        VIBESPACE_TOOL_GATEWAY_TOKEN: 'test-only',
      },
    },
    URL,
    crypto: { randomUUID: () => 'request-1' },
    fetch,
    AbortSignal: { timeout, any: (signals: AbortSignal[]) => AbortSignal.any(signals) },
  });
  return {
    call,
    fetch,
    timeout,
    context: {
      sessionID: 'session-1',
      messageID: 'message-1',
      abort: new AbortController().signal,
    },
  };
}

describe('generated native tool gateway transport', () => {
  it.each(['query', 'investigate'])(
    'allows the full bounded Context %s budget plus response delivery',
    async (operation) => {
      const f = fixture();
      expect(await f.call('vibespace_context', { operation }, f.context)).toBe('{"ok":true}');
      expect(f.timeout).toHaveBeenCalledWith(125_000);
    },
  );

  it('keeps ordinary tools bounded and preserves native cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    await f.call('context.list', {}, { ...f.context, abort: controller.signal });
    expect(f.timeout).toHaveBeenCalledWith(35_000);
    const signal = f.fetch.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it.each(['', '{'])('reports incomplete responses without a raw parser failure', async (body) => {
    const f = fixture(body);
    await expect(f.call('context.list', {}, f.context)).rejects.toThrow('invalid response');
  });

  it('preserves structured timeout failures', async () => {
    const f = fixture('{"ok":false,"code":"request_timeout"}');
    await expect(f.call('context.list', {}, f.context)).rejects.toThrow('request_timeout');
  });
});
