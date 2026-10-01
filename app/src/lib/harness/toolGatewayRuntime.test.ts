import { describe, expect, it, vi } from 'vitest';
import { createToolGatewayRuntime, type ToolGatewayDependencies } from './toolGatewayRuntime';
import { parseToolGatewayRequest, type ToolGatewayTool } from './toolGatewayProtocol';

function dependencies(approved = true) {
  const call = vi.fn(async (args, context): Promise<unknown> => ({ args, context }));
  const deps: ToolGatewayDependencies = {
    authorizeRequest: vi.fn(async () => true),
    authorizeMutation: vi.fn(async () => approved),
    terminal: {
      list: call,
      open: call,
      focus: call,
      spawn: call,
      write: call,
      read: call,
      schedule: call,
    },
    command: { list: call, run: call },
    profile: { readAllAboutMe: call, updateAllAboutMe: call },
    learning: { read: call, update: call },
    context: { list: call, read: call, attach: call, rlm: call },
    skills: { list: call, load: call },
    plugins: { list: call, run: call },
    tasks: { create: call, update: call },
    schedule: { create: call },
    app: { navigate: call, getState: call },
  };
  return { call, deps };
}

const argumentsByTool: Record<ToolGatewayTool, Record<string, unknown>> = {
  'terminal.list': {},
  'terminal.open': { terminal: 4 },
  'terminal.focus': { terminal: 4 },
  'terminal.spawn': {},
  'terminal.write': { terminal: 4, command: 'git status' },
  'terminal.read': { terminal: 4 },
  'terminal.schedule': { terminal: 4, command: 'npm test', runAt: 'tomorrow' },
  'command.list': {},
  'command.run': { command: 'open-settings' },
  'profile.allAboutMe.read': {},
  'profile.allAboutMe.update': { content: '# Me' },
  'memory.learning.read': {},
  'memory.learning.update': { content: 'fact', source: 'chat', confidence: 0.9 },
  'context.list': {},
  'context.read': { contextId: 'c-1' },
  'context.attach': { contextId: 'c-1' },
  vibespace_context: { operation: 'describe' },
  'skills.list': {},
  'skills.load': { skillId: 's-1' },
  'plugins.list': {},
  'plugins.run': { pluginId: 'p-1', operation: 'status' },
  'tasks.create': { title: 'Task' },
  'tasks.update': { taskId: 't-1', status: 'done' },
  'schedule.create': { title: 'Daily', schedule: 'daily', action: 'test' },
  'app.navigate': { route: '/settings' },
  'app.getState': {},
};

function request(tool: ToolGatewayTool) {
  return parseToolGatewayRequest({
    protocolVersion: 1,
    requestId: `request-${tool.replaceAll('.', '-')}`,
    sessionId: 'session-1',
    messageId: 'message-1',
    tool,
    args: argumentsByTool[tool],
    directory: 'C:\\work\\project',
    worktree: 'C:\\work\\project',
  });
}

describe('tool gateway semantic runtime', () => {
  it.each(Object.keys(argumentsByTool) as ToolGatewayTool[])(
    'dispatches %s through the fixed semantic dependency',
    async (tool) => {
      const { call, deps } = dependencies();
      const response = await createToolGatewayRuntime(deps).execute(request(tool));
      expect(response).toMatchObject({ requestId: request(tool).requestId, ok: true, code: 'ok' });
      expect(call).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledWith(
        argumentsByTool[tool],
        expect.objectContaining({
          sessionId: 'session-1',
          directory: 'C:\\work\\project',
        }),
      );
    },
  );

  it('binds every read to session authority without asking for mutation permission', async () => {
    const { deps } = dependencies();
    await createToolGatewayRuntime(deps).execute(request('terminal.read'));
    await createToolGatewayRuntime(deps).execute(request('context.read'));
    await createToolGatewayRuntime(deps).execute(request('vibespace_context'));
    await createToolGatewayRuntime(deps).execute(request('profile.allAboutMe.read'));
    await createToolGatewayRuntime(deps).execute(request('memory.learning.read'));
    await createToolGatewayRuntime(deps).execute(request('app.getState'));
    expect(deps.authorizeRequest).toHaveBeenCalledTimes(6);
    expect(deps.authorizeMutation).not.toHaveBeenCalled();
  });

  it('fails every tool closed when its session authority was revoked', async () => {
    const denied = dependencies();
    denied.deps.authorizeRequest = vi.fn(async () => false);

    const response = await createToolGatewayRuntime(denied.deps).execute(
      request('profile.allAboutMe.read'),
    );

    expect(response).toMatchObject({ ok: false, code: 'authority_revoked' });
    expect(denied.deps.authorizeMutation).not.toHaveBeenCalled();
    expect(denied.call).not.toHaveBeenCalled();
  });

  it('passes a permission-confirmed context to mutations and blocks denial', async () => {
    const allowed = dependencies(true);
    await createToolGatewayRuntime(allowed.deps).execute(request('terminal.write'));
    expect(allowed.deps.authorizeMutation).toHaveBeenCalledWith(request('terminal.write'));
    expect(allowed.call).toHaveBeenCalledWith(
      argumentsByTool['terminal.write'],
      expect.objectContaining({ mutationApproved: true }),
    );

    const denied = dependencies(false);
    const response = await createToolGatewayRuntime(denied.deps).execute(request('tasks.create'));
    expect(response).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(denied.call).not.toHaveBeenCalled();
  });

  it('turns dependency failures and oversized results into bounded protocol responses', async () => {
    const failed = dependencies();
    failed.call.mockRejectedValueOnce(new Error('vault token=do-not-leak'));
    await expect(
      createToolGatewayRuntime(failed.deps).execute(request('app.getState')),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: 'tool_failed',
        message: 'The semantic tool could not be completed.',
      }),
    );

    const oversized = dependencies();
    oversized.call.mockResolvedValueOnce({ body: 'x'.repeat(140_000) });
    await expect(
      createToolGatewayRuntime(oversized.deps).execute(request('terminal.list')),
    ).resolves.toMatchObject({ ok: false, code: 'response_too_large' });
  });
});
