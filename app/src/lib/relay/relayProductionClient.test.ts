import { describe, expect, it, vi } from 'vitest';
import type { ToolGatewayRelayPort } from '@/lib/harness/toolGatewayProduction';
import type { RelaySettings } from '@/features/settings/relaySettings';
import { createRelayProductionClient, readRelayLocalParticipants } from './relayProductionClient';

const request = {
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  sessionId: 'native-luna-thread-1',
  messageId: 'message-1',
  chatId: 'chat-1',
};

function fixture() {
  let activeChatId = 'chat-1';
  let workspaceId: string | null = 'workspace-1';
  let settings: RelaySettings = {
    scope: 'project',
    automaticParticipation: false,
    excludedParticipants: [],
  };
  let changed: (() => void) | undefined;
  let port: ToolGatewayRelayPort | undefined;
  const invocations: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let nativeRevision = 0;
  let raceOnce = false;
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      invocations.push({ command, args });
      if (command === 'relay_policy_snapshot') return { revision: nativeRevision, scope: 'off' };
      if (command === 'relay_policy_set') {
        const revision = (args?.policy as { revision: number }).revision;
        if (raceOnce) {
          raceOnce = false;
          nativeRevision = revision;
          throw new Error('Relay policy update is stale.');
        }
        if (revision <= nativeRevision) throw new Error('Relay policy update is stale.');
        nativeRevision = revision;
      }
      if (command === 'relay_active_context_snapshot')
        return {
          generation: 5,
          context: {
            accountId: 'account-1',
            workspaceId,
            projectId: 'project-1',
            chatId: activeChatId,
          },
        };
      if (command === 'relay_participant_bind')
        return {
          bindingId: 'binding-1',
          relayWorkspaceId: 'relay-project-1',
          relayAgentId: 'agent-1',
          relayAgentName: 'VibeSpace chat',
          channelName: 'vibespace',
        };
      if (command === 'relay_tools_list')
        return {
          tools: [
            { name: 'agent.list', inputSchema: { type: 'object', properties: {} } },
            {
              name: 'message.post',
              inputSchema: {
                type: 'object',
                properties: { channel: { type: 'string' }, text: { type: 'string' } },
              },
            },
            { name: 'workspace.switch', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      if (command === 'relay_participant_call') return { content: [{ type: 'text', text: 'ok' }] };
      return {};
    },
  );
  const release = vi.fn();
  const connector = createRelayProductionClient({
    invoke,
    readSettings: () => settings,
    subscribeSettings: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    installPort: (value) => {
      port = value;
      return release;
    },
  });
  return {
    connector,
    setWorkspaceId: (value: string | null) => { workspaceId = value; },
    invoke,
    invocations,
    release,
    port: () => port!,
    setSettings: (next: RelaySettings) => {
      settings = next;
      changed?.();
    },
    setActiveChatId: (chatId: string) => {
      activeChatId = chatId;
    },
    setNativeRevision: (revision: number) => {
      nativeRevision = revision;
    },
    raceNextPolicySet: () => {
      raceOnce = true;
    },
  };
}

describe('production Relay gateway client', () => {
  it('keeps Off entirely unavailable without starting the engine or binding an agent', async () => {
    const f = fixture();
    f.setSettings({ scope: 'off', automaticParticipation: false, excludedParticipants: [] });
    f.connector.start();
    expect(await f.port().forSession(request)).toBeNull();
    expect(f.invocations.map((entry) => entry.command)).not.toContain('relay_engine_start');
    expect(f.invocations.map((entry) => entry.command)).not.toContain('relay_participant_bind');
    await f.connector.stop();
  });

  it('reconciles with a newer native policy revision after host recreation', async () => {
    const f = fixture();
    f.setNativeRevision(Date.now() + 500_000);
    f.connector.start();
    expect(await f.port().forSession(request)).not.toBeNull();
    const policy = f.invocations.find((entry) => entry.command === 'relay_policy_set')?.args
      ?.policy as { revision: number };
    expect(policy.revision).toBeGreaterThan(Date.now() + 400_000);
    await f.connector.stop();
  });

  it('retries a native policy revision lost to a concurrent host publisher', async () => {
    const f = fixture();
    f.raceNextPolicySet();
    f.connector.start();
    expect(await f.port().forSession(request)).not.toBeNull();
    expect(f.invocations.filter((entry) => entry.command === 'relay_policy_set')).toHaveLength(2);
    await f.connector.stop();
  });

  it('binds the exact stored native chat once and exposes only discovered safe MCP tools', async () => {
    const f = fixture();
    f.connector.start();
    const first = await f.port().forSession(request);
    const second = await f.port().forSession(request);
    expect(first).toBe(second);
    expect(first?.availableToolNames).toEqual(['agent.list', 'message.post']);
    expect(readRelayLocalParticipants()).toContainEqual({
      relayAgentId: 'agent-1', chatId: 'chat-1',
      sessionId: 'native-luna-thread-1', projectId: 'project-1',
    });
    expect(
      f.invocations.filter((entry) => entry.command === 'relay_participant_bind'),
    ).toHaveLength(1);
    expect(
      f.invocations.find((entry) => entry.command === 'relay_participant_bind')?.args,
    ).toMatchObject({
      scope: {
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        chatId: 'chat-1',
      },
      sessionId: 'native-luna-thread-1',
      generation: 5,
      role: 'agent',
    });
    await expect(first?.call('agent.list', {})).resolves.toMatchObject({
      content: [{ text: 'ok' }],
    });
    expect(
      f.invocations.find((entry) => entry.command === 'relay_participant_call')?.args,
    ).toMatchObject({
      bindingId: 'binding-1',
      generation: 5,
      operation: 'agent.list',
      args: {},
    });
    await f.connector.stop();
    expect(readRelayLocalParticipants()).toEqual([]);
    expect(
      f.invocations.filter((entry) => entry.command === 'relay_policy_set').at(-1)?.args,
    ).toMatchObject({ policy: { scope: 'project' } });
    expect(f.invocations.map((entry) => entry.command)).toContain('relay_participant_unbind');
    await expect(first?.call('agent.list', {})).rejects.toThrow('revoked');
  });

  it('rejects a turn from another chat and revokes a bound handle on exclusion', async () => {
    const f = fixture();
    f.connector.start();
    expect(await f.port().forSession({ ...request, messageId: 'other-message', chatId: 'other-chat' })).toBeNull();
    const participant = await f.port().forSession(request);
    expect(participant).not.toBeNull();
    f.setSettings({
      scope: 'project',
      automaticParticipation: false,
      excludedParticipants: ['native-luna-thread-1'],
    });
    await expect(participant?.call('agent.list', {})).rejects.toThrow('revoked');
    expect(await f.port().forSession(request)).toBeNull();
    await f.connector.stop();
  });

  it('discards and unbinds enrollment when the native active chat changes during discovery', async () => {
    const f = fixture();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (command, args) => {
      const result = await original(command, args);
      if (command === 'relay_tools_list') f.setActiveChatId('chat-2');
      return result;
    });
    f.connector.start();
    expect(await f.port().forSession(request)).toBeNull();
    expect(f.invocations.map((entry) => entry.command)).toContain('relay_participant_unbind');
    await f.connector.stop();
  });
});


it('enrolls a local chat using the native nullable workspace scope', async () => {
  const f = fixture();
  f.setWorkspaceId(null);
  f.connector.start();
  const participant = await f.port().forSession({ ...request, workspaceId: '' });
  expect(participant).not.toBeNull();
  expect(f.invoke).toHaveBeenCalledWith('relay_participant_bind', expect.objectContaining({
    scope: expect.objectContaining({ workspaceId: null }), role: 'agent',
  }));
  await f.connector.stop();
});
