import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ProjectId, WorkspaceId } from '@/types/common';
import {
  clearToolGatewayMutationGrants,
  createProductionToolGatewayDependencies,
  grantNextToolGatewayMutation,
  grantToolGatewayMutation,
  installToolGatewayRlmContextPort,
  installToolGatewayPluginReadPort,
} from './toolGatewayProduction';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
} from './toolGatewayAuthority';
import { parseToolGatewayRequest } from './toolGatewayProtocol';

function mutation() {
  return parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    tool: 'app.navigate',
    args: { route: '/terminal' },
    directory: 'C:\\work\\project',
  });
}

describe('production tool gateway dependencies', () => {
  beforeEach(() => {
    clearToolGatewayMutationGrants();
    useAuthStore.setState({
      localUserId: 'account-a',
      cloudSession: null,
      workspaceId: 'workspace-a' as WorkspaceId,
      projectId: 'project-a' as ProjectId,
    });
    const authority = captureToolGatewayAuthorityClaim()!;
    bindToolGatewaySessionAuthority('session-1', authority);
    bindToolGatewaySessionAuthority('different-session', authority);
  });

  it('consumes an exact short-lived session grant once', async () => {
    const deps = createProductionToolGatewayDependencies();
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
    grantNextToolGatewayMutation('different-session');
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
    grantNextToolGatewayMutation('session-1');
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(mutation()))).resolves.toBe(false);
  });

  it('binds once and always grants to the exact semantic capability', async () => {
    const deps = createProductionToolGatewayDependencies();
    const navigation = mutation();
    const terminalWrite = parseToolGatewayRequest({
      ...navigation,
      requestId: 'request-2',
      tool: 'terminal.write',
      args: { terminal: 4, command: 'git status' },
    });

    grantToolGatewayMutation('session-1', 'app.navigate', 'once');
    await expect(Promise.resolve(deps.authorizeMutation(terminalWrite))).resolves.toBe(false);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(false);

    grantToolGatewayMutation('session-1', 'app.navigate', 'always');
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);
  });

  it.each([
    ['account', () => useAuthStore.setState({ localUserId: 'account-b' })],
    ['workspace', () => useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId })],
    ['project', () => useAuthStore.setState({ projectId: 'project-b' as ProjectId })],
  ])('revokes an approval when the %s authority changes', async (_label, transition) => {
    const deps = createProductionToolGatewayDependencies();
    const navigation = mutation();

    grantToolGatewayMutation('session-1', 'app.navigate', 'always');
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(true);

    transition();
    await expect(Promise.resolve(deps.authorizeMutation(navigation))).resolves.toBe(false);
  });

  it('binds reads to one scope and rejects the session after a scope transition', async () => {
    const deps = createProductionToolGatewayDependencies();
    const read = parseToolGatewayRequest({
      ...mutation(),
      requestId: 'request-read',
      tool: 'app.getState',
      args: {},
    });

    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(true);
    useAuthStore.setState({ workspaceId: 'workspace-b' as WorkspaceId });
    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(false);
    useAuthStore.setState({ workspaceId: 'workspace-a' as WorkspaceId });
    await expect(Promise.resolve(deps.authorizeRequest(read))).resolves.toBe(false);
  });

  it('reads bounded visible terminal and app state without mutation authority', async () => {
    useTerminalTranscriptStore.setState({ sessions: {} });
    useTerminalTranscriptStore.getState().registerSession('tty-1', {
      paneId: 'pane-1',
      projectId: null,
      command: 'pwsh',
    });
    useTerminalTranscriptStore.getState().appendOutput('tty-1', 'ready');
    useUIStore.getState().setRoute('chat');
    const deps = createProductionToolGatewayDependencies();

    await expect(Promise.resolve(deps.terminal.list({}, {} as never))).resolves.toEqual([
      expect.objectContaining({ sessionId: 'tty-1', outputChars: 5 }),
    ]);
    await expect(Promise.resolve(deps.app.getState({}, {} as never))).resolves.toEqual(
      expect.objectContaining({ route: 'chat', terminalCount: 1 }),
    );
  });

  it('delegates a fixed plugin operation through the live read-only security port', async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      summary: 'Fixed plugin tool completed.',
      data: { login: 'octocat' },
    }));
    const dispose = installToolGatewayPluginReadPort({ run });
    const deps = createProductionToolGatewayDependencies();
    const context = {
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      mutationApproved: false,
    };

    await expect(
      Promise.resolve(
        deps.plugins.run(
          {
            pluginId: 'github',
            operation: 'identity',
            input: JSON.stringify({}),
          },
          context,
        ),
      ),
    ).resolves.toEqual({
      summary: 'Fixed plugin tool completed.',
      data: { login: 'octocat' },
    });
    expect(run).toHaveBeenCalledWith({
      pluginId: 'github',
      operation: 'identity',
      params: {},
      context,
    });
    dispose();
    await expect(
      Promise.resolve(
        deps.plugins.run({ pluginId: 'github', operation: 'identity', input: '{}' }, context),
      ),
    ).rejects.toThrow('plugin_operation_unavailable');
  });

  it('does not let a stale plugin-port disposer revoke a newer host', async () => {
    const first = installToolGatewayPluginReadPort({
      run: vi.fn(async () => ({ ok: true as const, data: 'first' })),
    });
    const secondRun = vi.fn(async () => ({ ok: true as const, data: 'second' }));
    const second = installToolGatewayPluginReadPort({ run: secondRun });
    first();

    await expect(
      Promise.resolve(
        createProductionToolGatewayDependencies().plugins.run(
          { pluginId: 'mock-connector', operation: 'ping', input: '{}' },
          {
            requestId: 'request-2',
            sessionId: 'session-2',
            messageId: 'message-2',
            mutationApproved: false,
          },
        ),
      ),
    ).resolves.toEqual({ summary: undefined, data: 'second' });
    expect(secondRun).toHaveBeenCalledOnce();
    second();
  });

  it('binds the RLM context port to the current account, project, worktree, and session', async () => {
    const execute = vi.fn(async () => ({ mode: 'rlm', bounded: true }));
    const dispose = installToolGatewayRlmContextPort({ execute });
    const deps = createProductionToolGatewayDependencies();
    const context = {
      requestId: 'request-rlm',
      sessionId: 'session-1',
      messageId: 'message-1',
      directory: 'C:\\work\\project',
      worktree: 'C:\\work\\project\\.worktrees\\feature',
      mutationApproved: false,
    };

    await expect(
      Promise.resolve(deps.context.rlm({ operation: 'describe' }, context)),
    ).resolves.toEqual({ mode: 'rlm', bounded: true });
    expect(execute).toHaveBeenCalledWith(
      { operation: 'describe' },
      expect.objectContaining({
        sessionId: 'session-1',
        accountId: 'account-a',
        projectId: 'project-a',
        worktreeId: 'C:\\work\\project\\.worktrees\\feature',
      }),
    );
    dispose();
  });
});
