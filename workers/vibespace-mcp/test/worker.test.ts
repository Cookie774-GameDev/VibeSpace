import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { issueRelayTicket } from '../src/auth';
import type { Env } from '../src/contracts';
import { createMcpRequestHandler } from '../src/mcp';

const origin = 'https://vibespace-mcp.combatonline02.workers.dev';
const issuer = 'https://tipeobvisjqvpbzcpckh.supabase.co/auth/v1';
const subject = '99f194ac-1822-4ff8-b3b1-8a7338365646';
const workspaceId = 'workspace_1234567890';

function safeTool(name: 'fs.list' | 'fs.read') {
  return {
    type: 'function',
    function: {
      name,
      description:
        name === 'fs.list'
          ? 'List entries in a directory inside the workspace.'
          : 'Read a UTF-8 text file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  };
}

function registrationFrame(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'register',
    protocol_version: 2,
    client_nonce: 'nonce_1234567890123456',
    daemon_version: 'test',
    platform: 'test',
    tools: [safeTool('fs.list'), safeTool('fs.read')],
    writable: false,
    shell_enabled: false,
    workspace_grant: { id: workspaceId, display_name: 'VibeSpace Test' },
    ...overrides,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`${origin}${path}`, init);
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket frame.')),
      4_000,
    );
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

async function connectDesktop(): Promise<WebSocket> {
  const ticket = await issueRelayTicket(
    subject,
    'test-only-relay-ticket-signing-key-0000000000000000',
  );
  const upgrade = await SELF.fetch(
    request(`/browser-chat/bridge?ticket=${encodeURIComponent(ticket)}`, {
      headers: { upgrade: 'websocket' },
    }),
  );
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  expect(socket).not.toBeNull();
  socket!.accept();
  const registered = nextMessage(socket!);
  socket!.send(JSON.stringify(registrationFrame()));
  expect(await registered).toMatchObject({
    kind: 'registered',
    protocol_version: 2,
    session_id: expect.stringMatching(/^session_/u),
  });
  return socket!;
}

describe('VibeSpace MCP Worker', () => {
  it.each([
    [
      'workspace grant credential',
      registrationFrame({
        workspace_grant: {
          id: workspaceId,
          display_name: 'VibeSpace Test',
          token: 'nested-token',
        },
      }),
    ],
    [
      'tool credential',
      registrationFrame({
        tools: [{ ...safeTool('fs.read'), secret: 'nested-secret' }],
      }),
    ],
    [
      'function credential',
      registrationFrame({
        tools: [
          {
            ...safeTool('fs.read'),
            function: {
              ...safeTool('fs.read').function,
              authorization: 'nested-authorization',
            },
          },
        ],
      }),
    ],
    [
      'deep parameters credential',
      registrationFrame({
        tools: [
          {
            ...safeTool('fs.read'),
            function: {
              ...safeTool('fs.read').function,
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string', 'API Key': 'nested-api-key' },
                },
                required: ['path'],
              },
            },
          },
        ],
      }),
    ],
    [
      'unknown nested key',
      registrationFrame({
        tools: [
          {
            ...safeTool('fs.read'),
            function: { ...safeTool('fs.read').function, ignored_extra: true },
          },
        ],
      }),
    ],
    [
      'wrong tool type',
      registrationFrame({
        tools: [{ ...safeTool('fs.read'), type: 'command' }],
      }),
    ],
    [
      'altered tool description',
      registrationFrame({
        tools: [
          {
            ...safeTool('fs.read'),
            function: { ...safeTool('fs.read').function, description: 'Read any file.' },
          },
        ],
      }),
    ],
    [
      'altered parameters schema',
      registrationFrame({
        tools: [
          {
            ...safeTool('fs.read'),
            function: {
              ...safeTool('fs.read').function,
              parameters: {
                ...safeTool('fs.read').function.parameters,
                additionalProperties: false,
              },
            },
          },
        ],
      }),
    ],
    ['writable capability', registrationFrame({ writable: true })],
    ['shell capability', registrationFrame({ shell_enabled: true })],
  ])('rejects unsafe or inexact nested registration: %s', async (_label, frame) => {
    const ticket = await issueRelayTicket(
      subject,
      'test-only-relay-ticket-signing-key-0000000000000000',
    );
    const upgrade = await SELF.fetch(
      request(`/browser-chat/bridge?ticket=${encodeURIComponent(ticket)}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    const socket = upgrade.webSocket!;
    socket.accept();
    const outcome = Promise.race([
      nextMessage(socket).then(() => ({ kind: 'message' as const, code: 0 })),
      new Promise<{ kind: 'close'; code: number }>((resolve) =>
        socket.addEventListener('close', (event) => resolve({ kind: 'close', code: event.code }), {
          once: true,
        }),
      ),
    ]);
    socket.send(JSON.stringify(frame));
    await expect(outcome).resolves.toEqual({ kind: 'close', code: 4002 });
  });

  it.each([
    ['token', 'raw-token'],
    ['authorization', 'Bearer raw-token'],
    ['access_token', 'raw-token'],
    ['refresh_token', 'raw-token'],
    ['cookie', 'session=raw'],
    ['password', 'raw-password'],
    ['secret', 'raw-secret'],
    ['unknown_field', 'unexpected'],
  ])('rejects credential-shaped or unknown registration field %s', async (key, value) => {
    const ticket = await issueRelayTicket(
      subject,
      'test-only-relay-ticket-signing-key-0000000000000000',
    );
    const upgrade = await SELF.fetch(
      request(`/browser-chat/bridge?ticket=${encodeURIComponent(ticket)}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    const socket = upgrade.webSocket!;
    socket.accept();
    const outcome = Promise.race([
      nextMessage(socket).then(() => ({ kind: 'message' as const, code: 0 })),
      new Promise<{ kind: 'close'; code: number }>((resolve) =>
        socket.addEventListener('close', (event) => resolve({ kind: 'close', code: event.code }), {
          once: true,
        }),
      ),
    ]);
    socket.send(
      JSON.stringify({
        kind: 'register',
        protocol_version: 2,
        client_nonce: 'nonce_1234567890123456',
        daemon_version: 'test',
        platform: 'test',
        tools: [],
        writable: false,
        shell_enabled: false,
        [key]: value,
      }),
    );
    await expect(outcome).resolves.toEqual({ kind: 'close', code: 4002 });
  });

  it('registers the authenticated desktop relay without granting a local workspace', async () => {
    const ticket = await issueRelayTicket(
      subject,
      'test-only-relay-ticket-signing-key-0000000000000000',
    );
    const upgrade = await SELF.fetch(
      request(`/browser-chat/bridge?ticket=${encodeURIComponent(ticket)}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket!;
    socket.accept();
    const registered = nextMessage(socket);
    socket.send(
      JSON.stringify({
        kind: 'register',
        protocol_version: 2,
        client_nonce: 'nonce_1234567890123456',
        daemon_version: 'test',
        platform: 'test',
        tools: [],
        writable: false,
        shell_enabled: false,
      }),
    );

    expect(await registered).toMatchObject({ kind: 'registered', protocol_version: 2 });
    const heartbeatAck = nextMessage(socket);
    socket.send(JSON.stringify({ kind: 'heartbeat', ts: 1_725_000_000_000 }));
    expect(await heartbeatAck).toEqual({
      kind: 'heartbeat_ack',
      ts: 1_725_000_000_000,
    });
    const stub = (env as unknown as Env).USER_RELAY.getByName(subject);
    const relayStatus = await (await stub.fetch('https://relay.internal/internal/status')).json();
    expect(relayStatus).toEqual({
      connected: true,
      connectedAt: expect.any(Number),
      tools: [],
    });
    expect(relayStatus).not.toHaveProperty('workspace');
    socket.close(1000, 'test complete');
  });

  it('serves only the public consent bootstrap to the VibeSpace site origin', async () => {
    const response = await SELF.fetch(
      request('/public-config', {
        headers: { origin: 'https://vibespaceos.com' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://vibespaceos.com');
    await expect(response.json()).resolves.toEqual({
      supabase_url: 'https://tipeobvisjqvpbzcpckh.supabase.co',
      supabase_publishable_key: 'sb_publishable_test_only_value',
      provider_name: 'VibeSpace MCP',
    });

    const denied = await SELF.fetch(
      request('/public-config', {
        headers: { origin: 'https://attacker.example' },
      }),
    );
    expect(denied.status).toBe(403);
  });

  it('serves branded protected-resource metadata and challenges anonymous MCP calls', async () => {
    const metadata = await SELF.fetch(request('/.well-known/oauth-protected-resource/mcp'));
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [issuer],
      resource_name: 'VibeSpace MCP',
    });

    const challenged = await SELF.fetch(request('/mcp', { method: 'POST' }));
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('rejects missing or unverifiable tokens at the public MCP boundary', async () => {
    const response = await SELF.fetch(
      request('/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer invalid-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts an OAuth client token and reports the branded MCP server', async () => {
    const handler = createMcpRequestHandler(env as unknown as Env);
    const response = await handler.fetch(
      request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      }),
      {
        authInfo: {
          token: 'verified-by-worker',
          clientId: 'chatgpt-vibespace-mcp',
          scopes: ['email', 'profile'],
          extra: { sub: subject },
        },
      },
    );
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const dataLine = bodyText.split(/\r?\n/u).find((line) => line.startsWith('data: '));
    const body = JSON.parse(dataLine?.slice(6) ?? bodyText);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'VibeSpace MCP', version: '1.0.0' } },
    });
  });

  it('routes a bounded read call through the account Durable Object relay', async () => {
    const socket = await connectDesktop();
    const stub = (env as unknown as Env).USER_RELAY.getByName(subject);
    const status = await stub.fetch('https://relay.internal/internal/status');
    await expect(status.json()).resolves.toMatchObject({
      connected: true,
      workspace: { id: workspaceId, displayName: 'VibeSpace Test' },
      tools: ['fs.list', 'fs.read'],
    });

    const toolCallPromise = nextMessage(socket);
    const invocationPromise = stub.fetch('https://relay.internal/internal/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fs.read', args: { path: 'README.md' } }),
    });
    const toolCall = await toolCallPromise;
    expect(toolCall).toMatchObject({
      kind: 'tool_call',
      name: 'fs.read',
      args: { path: 'README.md' },
    });
    socket.send(
      JSON.stringify({
        kind: 'tool_result',
        session_id: toolCall.session_id,
        call_id: toolCall.call_id,
        sequence: toolCall.sequence,
        ok: true,
        result: { path: 'README.md', content: 'VibeSpace' },
      }),
    );
    const invocation = await invocationPromise;
    expect(invocation.status).toBe(200);
    await expect(invocation.json()).resolves.toEqual({
      ok: true,
      result: { path: 'README.md', content: 'VibeSpace' },
    });
    socket.close(1000, 'test complete');
  });

  it('rejects replayed tickets and unadvertised mutation tools', async () => {
    const ticket = await issueRelayTicket(
      subject,
      'test-only-relay-ticket-signing-key-0000000000000000',
    );
    const ticketUrl = `/browser-chat/bridge?ticket=${encodeURIComponent(ticket)}`;
    const first = await SELF.fetch(request(ticketUrl, { headers: { upgrade: 'websocket' } }));
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    const replay = await SELF.fetch(request(ticketUrl, { headers: { upgrade: 'websocket' } }));
    expect(replay.status).toBe(409);
    first.webSocket?.close(1000, 'test complete');

    const stub = (env as unknown as Env).USER_RELAY.getByName(subject);
    const denied = await stub.fetch('https://relay.internal/internal/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'terminal.run', args: { command: 'Get-Location' } }),
    });
    expect([403, 503]).toContain(denied.status);
  });
});
