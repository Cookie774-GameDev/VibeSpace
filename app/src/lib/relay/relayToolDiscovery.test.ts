import { readFileSync } from 'node:fs';
import { createServer, request as requestHttp } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { CODEX_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import {
  createCodexToolGateway,
  CODEX_MCP_LIST_TOOL,
  CODEX_MCP_RUN_TOOL,
  CODEX_COMMAND_LIST_TOOL,
} from '@/lib/ai/adapters/codexContextTool';
import * as mcpGatewayModule from '@/lib/mcp/vibeSpaceGateway';
import {
  installToolGatewayRelayPort,
  createProductionToolGatewayDependencies,
} from '@/lib/harness/toolGatewayProduction';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
} from '@/lib/harness/toolGatewayAuthority';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { writeRelaySettings } from '@/features/settings/relaySettings';
import {
  createRelayHostBridge,
  RELAY_GROUP_TOOL_NAMES,
  type RelayClientPort,
  type RelayHostSession,
} from './relayHostBridge';

vi.mock('@/lib/sync', () => ({ enqueueMutation: vi.fn(async () => 'relay-discovery-test') }));

const room = 'vibespace';
const session: RelayHostSession = {
  profileId: 'profile-test',
  accountId: 'account-test',
  workspaceId: 'workspace-test',
  projectId: 'project-test',
  sessionId: 'provider-test',
  generation: 1,
  relayWorkspaceId: 'relay-workspace-test',
  relayAgentId: 'relay-agent-test',
  relayAgentName: 'Test agent',
  role: 'agent',
};
const source = readFileSync('src-tauri/src/harness/server.rs', 'utf8');
const callSource = source.slice(
  source.indexOf('async function call(name, args, context)'),
  source.indexOf('const define = (name, description, args)'),
);
let releasePort: (() => void) | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({
    localUserId: session.accountId,
    cloudSession: null,
    workspaceId: session.workspaceId as WorkspaceId,
    projectId: session.projectId as ProjectId,
  });
  writeRelaySettings({ scope: 'project', automaticParticipation: false, excludedParticipants: [] });
  vi.spyOn(mcpGatewayModule, 'getVibeSpaceMcpGateway').mockReturnValue({
    restoreApprovedConnections: async () => ({}),
    getSnapshot: () => [],
  } as never);
});

afterEach(() => {
  releasePort?.();
  releasePort = undefined;
  releaseToolGatewaySessionAuthority(session.sessionId);
  writeRelaySettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
});

async function installBoundRoom() {
  const sendMessage = vi.fn(async () => ({ id: 'message-test' }));
  const list = vi.fn(async () => [
    { id: 'message-test', text: 'test message', channel: { name: room } },
  ]);
  const reply = vi.fn(async () => ({ id: 'reply-test' }));
  const client: RelayClientPort = {
    id: session.relayAgentId,
    name: session.relayAgentName,
    sendMessage,
    reply,
    workspace: { info: async () => ({ id: session.relayWorkspaceId }) },
    agents: {
      me: async () => ({ id: session.relayAgentId, name: session.relayAgentName, type: 'agent' }),
      list: async () => [],
    },
    channels: { join: vi.fn(async () => undefined) },
    messages: {
      list,
      get: async () => ({ id: 'message-test', channel: { name: room } }),
      markRead: async () => undefined,
      direct: async () => undefined,
    },
    threads: { get: async () => [] },
    inbox: { get: async () => [] },
  };
  const host = createRelayHostBridge({
    channel: room,
    policy: {
      mode: 'project',
      profileId: session.profileId,
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      relayWorkspaceId: session.relayWorkspaceId,
    },
    getLiveSession: () => session,
  });
  const participant = await host.bind(session, client);
  const forSession = vi.fn(() => participant);
  releasePort = installToolGatewayRelayPort({
    channel: room,
    availableToolNames: RELAY_GROUP_TOOL_NAMES,
    forSession,
  });
  return { sendMessage, list, reply, forSession };
}

describe('Agent Relay discovery through existing provider gateways', () => {
  it('lets Codex discover the scoped room and post, read and reply through its actual dynamic tools', async () => {
    const f = await installBoundRoom();
    const bridge = await createCodexToolGateway({
      requestId: 'turn-test',
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      chatId: 'chat-test',
      workingDirectory: 'C:\\relay-test',
      prompt: 'Use Agent Relay',
      tools: { vibespace_context: false, 'mcp.list': true, 'mcp.run': true },
      connection: CODEX_CLI_CONNECTION,
    });
    expect(bridge?.toolNames).toEqual(['mcp_list', 'mcp_run']);
    bridge!.bind(
      session.sessionId,
      {
        modelProvider: 'openai',
        model: 'gpt-6-luna',
        effort: 'low',
        serviceTier: null,
        cwd: 'C:\\relay-test',
      },
      'fixture-generation',
    );
    try {
      const discovered = await bridge!.executeTool!('mcp_list', {}, 'discover-test');
      expect(discovered.success).toBe(true);
      const catalog = JSON.parse(discovered.contentItems[0]!.text);
      expect(catalog.data[0]).toMatchObject({ connectionId: 'agent-relay' });
      expect(
        catalog.data[0].tools.find((tool: { name: string }) => tool.name === 'message.post')
          .inputSchema.properties.channel,
      ).toMatchObject({ const: room });
      for (const [toolName, classification, input] of [
        ['message.post', 'write', { channel: room, text: 'test message' }],
        ['message.list', 'read', { channel: room, limit: 5 }],
        ['message.reply', 'write', { message_id: 'message-test', text: 'test reply' }],
      ] as const) {
        expect(
          (
            await bridge!.executeTool!(
              'mcp_run',
              { connectionId: 'agent-relay', toolName, classification, input },
              randomUUID(),
            )
          ).success,
        ).toBe(true);
      }
      expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({
        to: '#vibespace',
        text: 'test message',
      });
      expect(f.list).toHaveBeenCalledExactlyOnceWith(room, {
        limit: 5,
        before: undefined,
        after: undefined,
      });
      expect(f.reply).toHaveBeenCalledExactlyOnceWith({
        messageId: 'message-test',
        text: 'test reply',
      });
      expect(f.forSession).toHaveBeenCalledWith({
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        sessionId: session.sessionId,
        messageId: 'turn-test',
        chatId: 'chat-test',
      });
      const denied = await bridge!.executeTool!(
        'mcp_run',
        {
          connectionId: 'agent-relay',
          toolName: 'message.post',
          classification: 'write',
          input: { channel: 'foreign-room', text: 'no' },
        },
        'foreign-room-test',
      );
      expect(denied.success).toBe(false);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      writeRelaySettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
      const off = await bridge!.executeTool!(
        'mcp_run',
        {
          connectionId: 'agent-relay',
          toolName: 'message.post',
          classification: 'write',
          input: { channel: room, text: 'no' },
        },
        'off-test',
      );
      expect(off.success).toBe(false);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      bridge!.dispose();
    }
  });

  it('runs the real OpenCode plugin call over authenticated localhost transport with exact turn and room scope', async () => {
    const f = await installBoundRoom();
    bindToolGatewaySessionAuthority(
      session.sessionId,
      captureToolGatewayAuthorityClaim()!,
      undefined,
      { requestId: 'turn-test', chatId: 'chat-test' },
    );
    const runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
    const received: unknown[] = [];
    let fixtureRequestCount = 0;
    let redirectNextRequest = false;
    const server = createServer(async (request, response) => {
      fixtureRequestCount += 1;
      if (
        request.url !== '/v1/tool' ||
        request.headers.authorization !== 'Bearer fixture-only-token'
      ) {
        response.writeHead(401).end();
        return;
      }
      if (redirectNextRequest) {
        response.writeHead(302, { location: 'https://example.invalid/never-follow' }).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        received.push(envelope);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await runtime.execute(parseToolGatewayRequest(envelope))));
      } catch {
        response.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local test server unavailable');
    const fixtureEndpoint = `http://127.0.0.1:${address.port}/v1/tool`;
    // Inject only into this VM. Never replace global fetch or authorize other localhost ports.
    const fixtureFetch: typeof fetch = async (input, init) => {
      if (String(input) !== fixtureEndpoint) {
        throw new Error('Fixture transport rejects unowned endpoints');
      }
      if (init?.method !== 'POST' || typeof init.body !== 'string') {
        throw new Error('Fixture transport requires the plugin JSON POST');
      }
      return new Promise<Response>((resolve, reject) => {
        // The destination is captured from our server, never taken from the request input.
        const request = requestHttp(
          fixtureEndpoint,
          {
            method: 'POST',
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            signal: init.signal ?? undefined,
            agent: false,
          },
          async (response) => {
            const status = response.statusCode ?? 500;
            if (status >= 300 && status < 400) {
              response.resume();
              reject(new Error('Fixture transport rejects redirects'));
              return;
            }
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of response) chunks.push(Buffer.from(chunk));
              resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status }));
            } catch (error) {
              reject(error);
            }
          },
        );
        request.once('error', reject);
        request.end(init.body);
      });
    };
    const guardedGlobalFetch = globalThis.fetch;
    const ask = vi.fn(async () => undefined);
    const call = runInNewContext(`(${callSource})`, {
      process: {
        env: {
          VIBESPACE_TOOL_GATEWAY_URL: fixtureEndpoint,
          VIBESPACE_TOOL_GATEWAY_TOKEN: 'fixture-only-token',
        },
      },
      URL,
      TextEncoder,
      crypto: { randomUUID },
      fetch: fixtureFetch,
      AbortSignal,
    });
    const context = {
      sessionID: session.sessionId,
      messageID: 'turn-test',
      directory: 'C:\\relay-test',
      worktree: 'C:\\relay-test',
      abort: new AbortController().signal,
      ask,
    };
    try {
      for (const unownedEndpoint of [
        'https://example.invalid/never-request',
        `http://127.0.0.1:${address.port + 1}/v1/tool`,
        `http://localhost:${address.port}/v1/tool`,
        `${fixtureEndpoint}/other`,
        `${fixtureEndpoint}?other=1`,
      ]) {
        await expect(fixtureFetch(unownedEndpoint, { method: 'POST', body: '{}' })).rejects.toThrow(
          'Fixture transport rejects unowned endpoints',
        );
      }
      expect(fixtureRequestCount).toBe(0);
      // Use our own URL to verify global denial safely, even if the guard regresses.
      // offlineNetwork.test separately proves external denial over an offline sentinel.
      await expect(fetch(fixtureEndpoint)).rejects.toThrow('Unmocked fetch is blocked');
      expect(fixtureRequestCount).toBe(0);
      const unauthorized = await fixtureFetch(fixtureEndpoint, { method: 'POST', body: '{}' });
      expect(unauthorized.status).toBe(401);
      expect(received).toHaveLength(0);

      const catalog = JSON.parse(await call('mcp.list', {}, context));
      expect(catalog.ok).toBe(true);
      expect(catalog.data[0].connectionId).toBe('agent-relay');
      for (const [toolName, classification, input] of [
        ['message.post', 'write', { channel: room, text: 'test message' }],
        ['message.list', 'read', { channel: room, limit: 5 }],
        ['message.reply', 'write', { message_id: 'message-test', text: 'test reply' }],
      ] as const) {
        expect(
          JSON.parse(
            await call(
              'mcp.run',
              { connectionId: 'agent-relay', toolName, classification, input },
              context,
            ),
          ).ok,
        ).toBe(true);
      }
      expect(ask).toHaveBeenCalledTimes(3);
      expect(received).toHaveLength(4);
      expect(
        received.every(
          (envelope) =>
            (envelope as { sessionId: string; messageId: string }).sessionId ===
              session.sessionId && (envelope as { messageId: string }).messageId === 'turn-test',
        ),
      ).toBe(true);
      expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({
        to: '#vibespace',
        text: 'test message',
      });
      expect(f.list).toHaveBeenCalledOnce();
      expect(f.reply).toHaveBeenCalledExactlyOnceWith({
        messageId: 'message-test',
        text: 'test reply',
      });
      expect(fixtureRequestCount).toBe(5);
      redirectNextRequest = true;
      await expect(call('mcp.list', {}, context)).rejects.toThrow(
        'Fixture transport rejects redirects',
      );
      expect(fixtureRequestCount).toBe(6);
      expect(received).toHaveLength(4);
      expect(globalThis.fetch).toBe(guardedGlobalFetch);
      await expect(fetch(fixtureEndpoint)).rejects.toThrow('Unmocked fetch is blocked');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('makes Relay discoverable in both registered provider tool descriptions', () => {
    expect(source.match(/"mcp_list": define\("mcp.list", "([^"]+)/)?.[1]).toContain('Agent Relay');
    expect(CODEX_MCP_LIST_TOOL.description).toContain('Agent Relay');
    expect(CODEX_MCP_RUN_TOOL.description).toContain('agent-relay');
    expect(CODEX_COMMAND_LIST_TOOL.description).toContain(
      'For Agent Relay messaging, use mcp_list',
    );
    expect(source.match(/"command_list": define\("command.list", "([^"]+)/)?.[1]).toContain(
      'For Agent Relay messaging, use mcp_list',
    );
  });
});
