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
    TextEncoder,
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
      ask: vi.fn().mockResolvedValue(undefined),
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

  it.each(['mcp.list', 'mcp.run'])('returns bounded structured %s failures so OpenCode can persist their payload', async (toolName) => {
    const body = JSON.stringify({
      ok: false,
      code: 'mcp_tool_failed',
      message: 'The external MCP tool reported an execution error.',
      data: {
        result: {
          ok: false,
          textExcerpts: ['LUNA_P36_HTTP_MCP_STRUCTURED_ERROR nonce=[redacted:high_entropy_candidate]'],
          sourceRefs: [],
          artifacts: ['https://example.com/luna-p36-report'],
          suggestedNextActions: [],
          structuredData: { code: 'fixture_structured_error', ok: false },
        },
        receipt: { status: 'failed' },
      },
    });
    const f = fixture(body);
    await expect(f.call(toolName, { connectionId: 'fixture', toolName: 'part1_structured_error' }, f.context))
      .resolves.toBe(body);
  });

  it('omits raw MCP inputs from the native approval metadata', async () => {
    const f = fixture();
    const raw = 'native-approval-secret-should-not-escape';
    await f.call('mcp.run', {
      connectionId: 'fixture',
      toolName: 'part1_echo_nonce',
      classification: 'write',
      input: { accessTokenRef: raw, safeInput: 'kept only for the gateway' },
    }, f.context);
    expect(f.context.ask).toHaveBeenCalledWith(expect.objectContaining({
      permission: 'mcp_run',
      metadata: { title: 'Allow mcp.run', args: {
        connectionId: 'fixture', toolName: 'part1_echo_nonce', classification: 'write',
      } },
    }));
    expect(JSON.stringify(f.context.ask.mock.calls)).not.toContain(raw);
    expect(JSON.stringify(f.context.ask.mock.calls)).not.toContain('safeInput');
  });

  it('retains the native response size guard before preserving MCP failures', async () => {
    const f = fixture(`{"ok":false,"code":"mcp_tool_failed","data":"${'x'.repeat(131073)}"}`);
    await expect(f.call('mcp.run', {}, f.context)).rejects.toThrow('safe size limit');
  });

  it.each([
    ['mcp.list', '[]'],
    ['mcp.list', '{}'],
    ['mcp.list', '{"ok":null}'],
    ['mcp.list', '{"ok":"true"}'],
    ['mcp.run', '[]'],
    ['mcp.run', '{}'],
    ['mcp.run', '{"ok":null}'],
    ['mcp.run', '{"ok":"true"}'],
  ] as const)('rejects malformed %s response envelopes (%s)', async (toolName, body) => {
    const f = fixture(body);
    await expect(f.call(toolName, {}, f.context)).rejects.toThrow('invalid response envelope');
  });

  it('counts UTF-8 bytes when enforcing the native response size guard', async () => {
    const f = fixture(JSON.stringify({ ok: false, code: 'mcp_tool_failed', data: 'é'.repeat(70_000) }));
    await expect(f.call('mcp.run', {}, f.context)).rejects.toThrow('safe size limit');
  });
});
