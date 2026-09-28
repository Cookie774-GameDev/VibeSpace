import { describe, expect, it, vi } from 'vitest';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { createOpenCodeHttpClient } from './openCodeClient';
import type { OpenCodeServerConnection } from './runtimeManager';

const connection: OpenCodeServerConnection = {
  source: 'managed',
  version: '1.2.3',
  generation: 'opencode-server-test',
};
const syntheticSecret = 'synthetic-secret-value';

describe('OpenCodeHttpClient', () => {
  it('rejects malformed managed server descriptors', () => {
    expect(() =>
      createOpenCodeHttpClient({ ...connection, generation: '../unsafe' }, { fetch: vi.fn() }),
    ).toThrow('managed server descriptor');
  });

  it('builds typed authenticated endpoints and encodes path segments', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'session/one', title: 'Chat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.getSession('session/one')).resolves.toEqual({
      id: 'session/one',
      title: 'Chat',
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1/session/session%2Fone');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
  });

  it('supports session creation, async prompts, cancellation, and permission replies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/session' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'session-1' }), { status: 200 });
      }
      if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      return new Response('true', { status: 200 });
    });
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.createSession({ title: 'Chat' }, 'C:\\workspace')).resolves.toEqual({
      id: 'session-1',
    });
    await client.promptAsync(
      'session-1',
      {
        model: { providerID: 'anthropic', modelID: 'claude' },
        parts: [{ type: 'text', text: 'hello' }],
        tools: { 'terminal.list': true, 'terminal.write': false },
      },
      undefined,
      'C:\\workspace',
    );
    await expect(client.abortSession('session-1', 'C:\\workspace')).resolves.toBe(true);
    await expect(
      client.replyPermission('session-1', 'approval/1', 'once', 'C:\\workspace'),
    ).resolves.toBe(true);

    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/session',
      '/session/session-1/prompt_async',
      '/session/session-1/abort',
      '/session/session-1/permissions/approval%2F1',
    ]);
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('directory')),
    ).toEqual(['C:\\workspace', 'C:\\workspace', 'C:\\workspace', 'C:\\workspace']);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      tools: { 'terminal.list': true, 'terminal.write': false },
    });
  });

  it('sends image data to OpenCode without retaining base64 bytes in activity diagnostics', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createOpenCodeHttpClient(connection, { fetch });
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const beforeSequence = appActivityLog.snapshot().sequence;

    await client.promptAsync('session-image', {
      model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
      parts: [
        { type: 'text', text: 'Describe this.' },
        { type: 'file', mime: 'image/png', url: dataUrl, filename: 'tiny.png' },
      ],
    });

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { parts: unknown[] };
    expect(body.parts[1]).toMatchObject({ type: 'file', url: dataUrl });
    const diagnostics = JSON.stringify(appActivityLog.snapshot(beforeSequence).events);
    expect(diagnostics).not.toContain('aGVsbG8=');
    expect(diagnostics).toContain('[image payload omitted');
  });

  it('patches only a bounded verified Qwen endpoint into managed OpenCode config', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ provider: {} }), { status: 200 }));
    const client = createOpenCodeHttpClient(connection, { fetch });
    const endpoint = 'https://coding-intl.dashscope.aliyuncs.com/v1';

    await client.configureQwenEndpoint(endpoint);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/config');
    expect(init?.method).toBe('PATCH');
    const serialized = String(init?.body);
    expect(JSON.parse(serialized)).toEqual({
      provider: { qwen: { options: { baseURL: endpoint } } },
    });
    expect(serialized).not.toMatch(/apiKey|authorization|bearer|secret|token/i);
  });

  it('rejects an unrecognized Qwen endpoint before contacting OpenCode', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.configureQwenEndpoint('https://attacker.example/v1')).rejects.toThrow(
      'verified Qwen endpoint',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers provider auth, authorizes the exact dynamic method, and completes callbacks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/provider/auth') {
        return new Response(
          JSON.stringify({
            openai: [{ type: 'oauth', label: 'ChatGPT Plus/Pro' }],
            anthropic: [{ type: 'api', label: 'API key' }],
          }),
          { status: 200 },
        );
      }
      if (path === '/provider') {
        return new Response(JSON.stringify({ all: [], default: {}, connected: ['openai'] }), {
          status: 200,
        });
      }
      if (path.endsWith('/oauth/authorize')) {
        return new Response(
          JSON.stringify({
            url: 'https://auth.example.test/device',
            method: 'auto',
            instructions: 'Open the browser and approve.',
          }),
          { status: 200 },
        );
      }
      return new Response('true', { status: 200 });
    });
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.providerAuthMethods()).resolves.toEqual({
      openai: [{ type: 'oauth', label: 'ChatGPT Plus/Pro' }],
      anthropic: [{ type: 'api', label: 'API key' }],
    });
    await expect(client.providerStatus()).resolves.toEqual({ connected: ['openai'] });
    await expect(
      client.authorizeProvider('github/copilot', 2, { host: 'github.com' }),
    ).resolves.toEqual({
      url: 'https://auth.example.test/device',
      method: 'auto',
      instructions: 'Open the browser and approve.',
    });
    await expect(client.callbackProvider('github/copilot', 2)).resolves.toBe(true);

    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/provider/auth',
      '/provider',
      '/provider/github%2Fcopilot/oauth/authorize',
      '/provider/github%2Fcopilot/oauth/callback',
    ]);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      method: 2,
      inputs: { host: 'github.com' },
    });
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({ method: 2 });
  });

  it('accepts provider status responses larger than the generic JSON limit', async () => {
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          all: [{ id: 'openai', models: { test: { description: padding } } }],
          default: {},
          connected: ['openai'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.providerStatus()).resolves.toEqual({ connected: ['openai'] });
  });

  it('rejects malformed or oversized provider auth schemas', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ openai: [{ type: 'cookie', label: 'Scrape browser' }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: `https://example.test/${'x'.repeat(3_000)}`,
            method: 'auto',
            instructions: 'approve',
          }),
          { status: 200 },
        ),
      );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.providerAuthMethods()).rejects.toThrow('invalid provider auth');
    await expect(client.authorizeProvider('openai', 0)).rejects.toThrow('invalid authorization');
  });

  it('uses OpenCode authoritative MCP status and lifecycle routes in the exact workspace', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/mcp') {
        return new Response(
          JSON.stringify({
            github: { status: 'connected' },
            playwright: { status: 'disabled' },
            private: { status: 'failed', error: `Bearer ${syntheticSecret}` },
          }),
          { status: 200 },
        );
      }
      return new Response('true', { status: 200 });
    });
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.mcpStatus('C:\\workspace')).resolves.toEqual({
      github: { status: 'connected' },
      playwright: { status: 'disabled' },
      private: { status: 'failed', error: 'Bearer [REDACTED]' },
    });
    await expect(client.connectMcp('github', 'C:\\workspace')).resolves.toBe(true);
    await expect(client.disconnectMcp('github', 'C:\\workspace')).resolves.toBe(true);

    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/mcp',
      '/mcp/github/connect',
      '/mcp/github/disconnect',
    ]);
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('directory')),
    ).toEqual(['C:\\workspace', 'C:\\workspace', 'C:\\workspace']);
  });

  it('adds exact remote and local MCP definitions through OpenCode without substitution', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ docs: { status: 'connected' } }), { status: 200 }),
      );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await client.addMcp(
      'docs',
      {
        type: 'remote',
        url: 'https://mcp.example.test/rpc',
        enabled: true,
        headers: { Authorization: `Bearer ${syntheticSecret}` },
      },
      'C:\\workspace',
    );
    await client.addMcp(
      'local-tools',
      {
        type: 'local',
        command: ['node', 'server.mjs'],
        enabled: false,
        environment: { LOG_LEVEL: 'info' },
      },
      'C:\\workspace',
    );

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      {
        name: 'docs',
        config: {
          type: 'remote',
          url: 'https://mcp.example.test/rpc',
          enabled: true,
          headers: { Authorization: `Bearer ${syntheticSecret}` },
        },
      },
      {
        name: 'local-tools',
        config: {
          type: 'local',
          command: ['node', 'server.mjs'],
          enabled: false,
          environment: { LOG_LEVEL: 'info' },
        },
      },
    ]);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === '/mcp')).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('fails closed on malformed MCP status and unsafe MCP definitions', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ forged: { status: 'running' } }), { status: 200 }),
      );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.mcpStatus()).rejects.toThrow('invalid MCP status');
    await expect(
      client.addMcp('unsafe/name', { type: 'remote', url: 'http://remote.example.test/mcp' }),
    ).rejects.toThrow('MCP');
    await expect(
      client.addMcp('unsafe', { type: 'local', command: ['node', 'bad\u0000arg'] }),
    ).rejects.toThrow('MCP');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects and redacts credentials from bounded server errors', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockResolvedValueOnce(
        new Response(`Bearer ${syntheticSecret} ${'x'.repeat(10_000)}`, { status: 500 }),
      );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.health()).rejects.toThrow('redirect');
    await expect(client.health()).rejects.toSatisfy((error: Error) => {
      expect(error.message).not.toContain(syntheticSecret);
      expect(error.message.length).toBeLessThan(2_300);
      return true;
    });
  });

  it('preserves a redacted native string rejection instead of losing its repair code', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      `OpenCode transport request exceeded its safe bound. Bearer ${syntheticSecret}`,
    );
    const client = createOpenCodeHttpClient(connection, { fetch });

    await expect(client.health()).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain('OpenCode transport request exceeded its safe bound.');
      expect(error.message).not.toContain(syntheticSecret);
      return true;
    });
  });

  it('requires an authenticated event-stream response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('not a stream', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const client = createOpenCodeHttpClient(connection, { fetch });
    const consume = async () => {
      for await (const _event of client.events()) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow('event stream');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBeNull();
  });
});


it('uses project-scoped MCP browser authentication and removal endpoints, not ordinary connect', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'connected' })))
    .mockResolvedValueOnce(new Response('true'));
  const client = createOpenCodeHttpClient(connection, { fetch });
  await expect(client.authenticateMcp('supabase:readonly', 'C:/Project One')).resolves.toEqual({ status: 'connected' });
  await expect(client.removeMcpAuth('supabase:readonly', 'C:/Project One')).resolves.toBe(true);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'http://127.0.0.1/mcp/supabase%3Areadonly/auth/authenticate?directory=C%3A%2FProject+One',
    'http://127.0.0.1/mcp/supabase%3Areadonly/auth?directory=C%3A%2FProject+One',
  ]);
  expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
});

it('rejects false MCP authorization success and invalid names before contacting the sidecar', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('true'));
  const client = createOpenCodeHttpClient(connection, { fetch });
  await expect(client.authenticateMcp('supabase')).rejects.toThrow(/invalid MCP status/i);
  fetch.mockClear();
  await expect(client.authenticateMcp('unsafe/name')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
