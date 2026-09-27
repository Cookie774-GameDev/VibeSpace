import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpGatewayModule from '@/lib/mcp/vibeSpaceGateway';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import {
  clearToolGatewayMutationGrants,
  createProductionToolGatewayDependencies,
  grantToolGatewayMutation,
  installToolGatewayRelayPort,
} from '@/lib/harness/toolGatewayProduction';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
} from '@/lib/harness/toolGatewayAuthority';
import { RELAY_GROUP_TOOL_NAMES, type RelayParticipantHandle } from './relayHostBridge';
import { writeRelaySettings } from '@/features/settings/relaySettings';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';

vi.mock('@/lib/sync', () => ({ enqueueMutation: vi.fn(async () => 'relay-gateway-test') }));

const context = {
  requestId: 'request-relay-1',
  sessionId: 'session-relay-1',
  messageId: 'message-relay-1',
  mutationApproved: false,
};

describe('Relay through the existing tool gateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearToolGatewayMutationGrants();
    writeRelaySettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
    useAuthStore.setState({
      localUserId: 'account-relay',
      cloudSession: null,
      workspaceId: 'workspace-relay' as WorkspaceId,
      projectId: 'project-relay' as ProjectId,
    });
    const authority = captureToolGatewayAuthorityClaim()!;
    bindToolGatewaySessionAuthority(context.sessionId, authority, undefined, {
      requestId: context.messageId,
      chatId: 'chat-relay-1',
    });
    vi.spyOn(mcpGatewayModule, 'getVibeSpaceMcpGateway').mockReturnValue({
      restoreApprovedConnections: vi.fn(async () => ({
        restoredIds: [],
        skippedIds: [],
        failedIds: [],
      })),
      getSnapshot: vi.fn(() => []),
      invoke: vi.fn(),
    } as never);
  });

  it('does not advertise or run Relay when no host participant is bound', async () => {
    const deps = createProductionToolGatewayDependencies();
    expect(await deps.mcp.list({}, context)).toEqual([]);
    await expect(
      deps.mcp.run(
        {
          connectionId: 'agent-relay',
          toolName: 'agent.list',
          classification: 'read',
          input: {},
        },
        context,
      ),
    ).rejects.toThrow('mcp_tool_unavailable');
  });

  it('stays unavailable when the host has not discovered upstream MCP tools', async () => {
    const call = vi.fn();
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: [],
      forSession: () => ({ sessionId: context.sessionId, role: 'agent', call }),
    });
    try {
      const deps = createProductionToolGatewayDependencies();
      expect(await deps.mcp.list({}, context)).toEqual([]);
      await expect(
        deps.mcp.run(
          {
            connectionId: 'agent-relay',
            toolName: 'agent.list',
            classification: 'read',
            input: {},
          },
          context,
        ),
      ).rejects.toThrow('mcp_tool_unavailable');
      expect(call).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('waits for an authenticated asynchronous native participant before discovering tools', async () => {
    const call = vi.fn(async () => [{ id: 'agent-1', name: 'Luna', type: 'agent' }]);
    const handle: RelayParticipantHandle = { sessionId: context.sessionId, role: 'agent', call };
    const forSession = vi.fn(async () => handle);
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: RELAY_GROUP_TOOL_NAMES,
      forSession,
    });
    try {
      const deps = createProductionToolGatewayDependencies();
      const list = (await deps.mcp.list({}, context)) as Array<{ connectionId: string }>;
      expect(list.map((entry) => entry.connectionId)).toContain('agent-relay');
      expect(forSession).toHaveBeenCalledWith({
        accountId: 'account-relay',
        workspaceId: 'workspace-relay',
        projectId: 'project-relay',
        sessionId: context.sessionId,
        messageId: context.messageId,
        chatId: 'chat-relay-1',
      });
      await deps.mcp.run(
        {
          connectionId: 'agent-relay',
          toolName: 'agent.list',
          classification: 'read',
          input: {},
        },
        context,
      );
      expect(call).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it('projects the pinned MCP schema while stripping privileged workspace and impersonation fields', async () => {
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: ['message.post'],
      forSession: () => ({
        sessionId: context.sessionId,
        role: 'agent',
        call: vi.fn(),
        availableToolNames: ['message.post'],
        availableTools: [
          {
            name: 'message.post',
            description: 'Official Relaycast post description',
            inputSchema: {
              type: 'object',
              properties: {
                channel: { type: 'string' },
                text: { type: 'string', description: 'Official text description' },
                workspace_id: { type: 'string' },
                as: { type: 'string' },
              },
              required: ['channel', 'text'],
            },
          },
        ],
      }),
    });
    try {
      const list = (await createProductionToolGatewayDependencies().mcp.list(
        {},
        context,
      )) as Array<{
        tools: Array<{ description: string; inputSchema: { properties: Record<string, unknown> } }>;
      }>;
      expect(list[0]?.tools[0]?.description).toBe('Official Relaycast post description');
      expect(list[0]?.tools[0]?.inputSchema.properties).toMatchObject({
        channel: { const: 'team' },
        text: { description: 'Official text description' },
      });
      expect(Object.keys(list[0]?.tools[0]?.inputSchema.properties ?? {})).toEqual([
        'channel',
        'text',
      ]);
    } finally {
      release();
    }
  });

  it('advertises only verified upstream tools and routes with the bound session scope', async () => {
    const call = vi.fn(async () => [{ id: 'agent-1', name: 'Builder', type: 'agent' }]);
    const handle: RelayParticipantHandle = { sessionId: context.sessionId, role: 'agent', call };
    const forSession = vi.fn(() => handle);
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: [...RELAY_GROUP_TOOL_NAMES, 'workspace.switch'],
      forSession,
    });
    try {
      const deps = createProductionToolGatewayDependencies();
      const list = (await deps.mcp.list({}, context)) as Array<{
        connectionId: string;
        tools: Array<{ name: string; classification: string; inputSchema: unknown }>;
      }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.connectionId).toBe('agent-relay');
      expect(list[0]?.tools.map((tool) => tool.name)).toEqual(RELAY_GROUP_TOOL_NAMES);
      expect(list[0]?.tools.find((tool) => tool.name === 'message.post')?.classification).toBe(
        'write',
      );
      expect(list[0]?.tools.find((tool) => tool.name === 'message.list')?.classification).toBe(
        'read',
      );
      expect(
        list[0]?.tools.find((tool) => tool.name === 'message.post')?.inputSchema,
      ).toMatchObject({
        properties: { channel: { const: 'team' } },
      });
      expect(
        list[0]?.tools.some((tool) => /workspace|register|spawn|file|command/.test(tool.name)),
      ).toBe(false);
      expect(forSession).toHaveBeenCalledWith({
        accountId: 'account-relay',
        workspaceId: 'workspace-relay',
        projectId: 'project-relay',
        sessionId: context.sessionId,
        messageId: context.messageId,
        chatId: 'chat-relay-1',
      });

      const response = await deps.mcp.run(
        {
          connectionId: 'agent-relay',
          toolName: 'agent.list',
          classification: 'read',
          input: {},
        },
        context,
      );
      expect(call).toHaveBeenCalledWith('agent.list', {});
      expect(response).toMatchObject({ result: { ok: true, contentTrust: 'untrusted' } });
      await expect(
        deps.mcp.run(
          {
            connectionId: 'agent-relay',
            toolName: 'message.post',
            classification: 'read',
            input: { channel: 'team', text: 'hello' },
          },
          context,
        ),
      ).rejects.toThrow('mcp_tool_unavailable');
      expect(call).toHaveBeenCalledTimes(1);
      await expect(
        deps.mcp.run(
          {
            connectionId: 'agent-relay',
            toolName: 'message.post',
            classification: 'write',
            input: { channel: 'team', text: 'hello', as: 'owner', workspace_id: 'another' },
          },
          context,
        ),
      ).rejects.toThrow('mcp_tool_unavailable');
      await expect(
        deps.mcp.run(
          {
            connectionId: 'agent-relay',
            toolName: 'message.post',
            classification: 'write',
            input: { channel: 'other-room', text: 'hello' },
          },
          context,
        ),
      ).rejects.toThrow('mcp_tool_unavailable');
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it('rejects a wrong-session or human handle and preserves a newer host installation', async () => {
    const stale = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: RELAY_GROUP_TOOL_NAMES,
      forSession: () => ({ sessionId: 'other', role: 'agent', call: vi.fn() }),
    });
    const current = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: RELAY_GROUP_TOOL_NAMES,
      forSession: () => ({ sessionId: context.sessionId, role: 'human', call: vi.fn() }),
    });
    stale();
    try {
      expect(await createProductionToolGatewayDependencies().mcp.list({}, context)).toEqual([]);
    } finally {
      current();
    }
  });

  it('keeps Relay Off even when an ordinary semantic mutation grant exists', async () => {
    const call = vi.fn(async () => ({ messageId: 'accepted-1' }));
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: RELAY_GROUP_TOOL_NAMES,
      forSession: () => ({ sessionId: context.sessionId, role: 'agent', call }),
    });
    try {
      const request = parseToolGatewayRequest({
        protocolVersion: 1,
        requestId: context.requestId,
        sessionId: context.sessionId,
        messageId: context.messageId,
        tool: 'mcp.run',
        args: {
          connectionId: 'agent-relay',
          toolName: 'message.post',
          classification: 'write',
          input: { channel: 'team', text: 'hello' },
        },
      });
      const runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
      expect(await runtime.execute(request)).toMatchObject({
        ok: false,
        code: 'permission_denied',
      });
      expect(call).not.toHaveBeenCalled();
      grantToolGatewayMutation(context.sessionId, 'mcp.run', 'once');
      expect(await runtime.execute(request)).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(call).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('accepts only scoped Relay messaging writes after the user enables Project collaboration', async () => {
    writeRelaySettings({ scope: 'project', automaticParticipation: false, excludedParticipants: [] });
    const call = vi.fn(async () => ({ messageId: 'accepted-2' }));
    const release = installToolGatewayRelayPort({
      channel: 'team',
      availableToolNames: RELAY_GROUP_TOOL_NAMES,
      forSession: () => ({ sessionId: context.sessionId, role: 'agent', call }),
    });
    try {
      const runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
      const request = parseToolGatewayRequest({
        protocolVersion: 1,
        requestId: context.requestId,
        sessionId: context.sessionId,
        messageId: context.messageId,
        tool: 'mcp.run',
        args: {
          connectionId: 'agent-relay', toolName: 'message.post', classification: 'write',
          input: { channel: 'team', text: 'hello' },
        },
      });
      expect(await runtime.execute(request)).toMatchObject({ ok: true, code: 'ok' });
      expect(call).toHaveBeenCalledExactlyOnceWith('message.post', { channel: 'team', text: 'hello' });
      writeRelaySettings({ scope: 'project', automaticParticipation: false, excludedParticipants: [context.sessionId] });
      expect(await runtime.execute(request)).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      release();
      writeRelaySettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
    }
  });
});
