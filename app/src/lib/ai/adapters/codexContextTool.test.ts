import { beforeEach, expect, it, vi } from 'vitest';
import { createCodexContextTool, createCodexToolGateway } from './codexContextTool';
import type { ProviderRequest } from './types';

const state = vi.hoisted(() => ({
  enabled: true, authorized: true,
  capture: vi.fn(() => ({
    scope: { accountId: 'account', workspaceId: 'workspace', projectId: 'project' },
    generation: 1,
  })),
  execute: vi.fn(async () => ({ ok: true, data: { evidence: 'verified' } })),
  release: vi.fn(), observed: vi.fn(() => true),
  bind: vi.fn(() => state.authorized),
  grantMutation: vi.fn(() => vi.fn()),
}));
vi.mock('@/features/context/rlmPreferenceStore', () => ({ resolveRlmEnabled: () => ({ enabled: state.enabled }) }));
vi.mock('@/lib/harness/toolGatewayAuthority', () => ({
  captureToolGatewayAuthorityClaim: state.capture,
  bindToolGatewaySessionAuthority: state.bind,
  bindToolGatewayObservedExecutionAuthority: state.observed,
  authorizeToolGatewayRequest: () => state.authorized,
  grantToolGatewayMutationForRequest: state.grantMutation,
  releaseToolGatewaySessionAuthority: state.release,
}));
vi.mock('@/lib/harness/toolGatewayProduction', () => ({ createProductionToolGatewayDependencies: () => ({}) }));
vi.mock('@/lib/harness/toolGatewayRuntime', () => ({ createToolGatewayRuntime: () => ({ execute: state.execute }) }));

const request = {
  requestId: 'request', accountId: 'account', workspaceId: 'workspace', projectId: 'project',
  chatId: 'chat', workingDirectory: 'C:\\project', prompt: 'Audit',
  connection: { id: 'openai-codex', adapterId: 'codex-app-server', authSource: 'subscription' },
} as ProviderRequest;
const identity = { modelProvider: 'openai', model: 'opencode-go/deepseek-v4-flash-vision-exp', effort: null, serviceTier: null, cwd: 'C:\\project' };
beforeEach(() => { state.enabled = true; state.authorized = true; state.capture.mockReset(); state.capture.mockReturnValue({ scope: { accountId: 'account', workspaceId: 'workspace', projectId: 'project' }, generation: 1 }); vi.clearAllMocks(); });

it('binds the exact protected provider attempt without substituting the tool call ID', async () => {
  const protectedAttempt = { accountId: 'account', runId: 'run', requestId: 'request', attemptNumber: 3 };
  const bridge = (await createCodexContextTool({ ...request, protectedAttempt }))!;
  bridge.bind('protected-thread', identity, 'native-generation');
  expect(state.bind).toHaveBeenCalledWith('protected-thread', expect.anything(), undefined, {
    requestId: 'request', chatId: 'chat', protectedAttempt,
  });
  bridge.dispose();
});

it('uses the existing validated gateway envelope and releases its exact session', async () => {
  // The native adapter may resolve the working directory after tool preparation.
  const bridge = (await createCodexContextTool({ ...request, workingDirectory: undefined }))!;
  bridge.bind('thread', identity, 'native-generation');
  expect(await bridge.execute({ operation: 'investigate', query: 'current retention' }, 'call')).toMatchObject({ success: true });
  expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'thread', directory: 'C:\\project', tool: 'vibespace_context' }));
  expect(state.observed).toHaveBeenCalledWith('thread', expect.anything(), expect.objectContaining({ executionIdentity: expect.objectContaining({ upstreamProviderId: 'opencode-go', catalogRevision: 'native-generation' }) }));
  bridge.dispose();
  expect(state.release).toHaveBeenCalledWith('thread');
});

it('does not advertise Context for disabled RLM, explicit disk reads or foreign scope', async () => {
  expect(await createCodexContextTool({ ...request, tools: { vibespace_context: false } })).toBeNull();
  expect(await createCodexContextTool({ ...request, explicitReadRoot: true })).toBeNull();
  expect(await createCodexContextTool({ ...request, projectId: 'foreign' })).toBeNull();
  state.enabled = false;
  expect(await createCodexContextTool(request)).toBeNull();
});

it('uses an early claim after project navigation instead of recapturing the active project', async () => {
  const earlyClaim = Object.freeze({
    scope: Object.freeze({ accountId: 'account', accountSource: 'local' as const, workspaceId: 'workspace', projectId: 'project' }),
    generation: 1,
  });
  state.capture.mockReturnValue({
    scope: { accountId: 'account', workspaceId: 'workspace', projectId: 'project-b' },
    generation: 2,
  });
  const bridge = await createCodexContextTool({ ...request, toolGatewayAuthority: earlyClaim });
  expect(bridge).not.toBeNull();
  expect(state.capture).not.toHaveBeenCalled();
  bridge?.dispose();
});

it('fails closed when early authority capture explicitly returned null', async () => {
  const bridge = await createCodexContextTool({ ...request, toolGatewayAuthority: null });
  expect(bridge).toBeNull();
  expect(state.capture).not.toHaveBeenCalled();
});

it('rejects malformed operations, cancellation and revoked authority before delivery', async () => {
  const controller = new AbortController();
  const bridge = (await createCodexContextTool({ ...request, signal: controller.signal }))!;
  bridge.bind('thread', identity, 'native-generation');
  await expect(bridge.execute({ operation: 'delete' }, 'call')).rejects.toThrow();
  expect(state.execute).not.toHaveBeenCalled();
  state.authorized = false;
  await expect(bridge.execute({ operation: 'describe' }, 'call')).rejects.toThrow('authority changed');
  controller.abort();
  await expect(bridge.execute({ operation: 'describe' }, 'call')).rejects.toThrow('inactive');
  bridge.dispose();
});

it('advertises only the requested semantic MCP tools and routes them through the scoped runtime', async () => {
  const bridge = (await createCodexToolGateway({
    ...request,
    tools: { vibespace_context: false, 'mcp.list': true, 'mcp.run': true },
  }))!;
  expect(bridge.dynamicTools?.map((tool) => tool.name)).toEqual(['mcp_list', 'mcp_run']);
  bridge.bind('mcp-thread', identity, 'mcp-generation');
  expect(state.bind).toHaveBeenCalledWith(
    'mcp-thread', expect.anything(), undefined, { requestId: 'request', chatId: 'chat' },
  );
  await expect(bridge.executeTool?.('mcp_list', {}, 'mcp-list-call')).resolves.toMatchObject({ success: true });
  expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'mcp-thread', tool: 'mcp.list', args: {},
  }));
  await expect(bridge.executeTool?.('mcp_run', {
    connectionId: 'fixture', toolName: 'part1_echo_nonce', classification: 'read', input: { nonce: 'safe' },
  }, 'mcp-run-call')).resolves.toMatchObject({ success: true });
  expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'mcp-thread', tool: 'mcp.run', args: expect.objectContaining({ connectionId: 'fixture' }),
  }));
  bridge.dispose();
});

it('does not expose semantic MCP tools without an explicit request or under the root read policy', async () => {
  expect(await createCodexToolGateway({ ...request, tools: { vibespace_context: false } })).toBeNull();
  expect(await createCodexToolGateway({ ...request, tools: { 'mcp.list': true }, explicitReadRoot: true })).toBeNull();
});

it('connects enabled plugins to the same native Codex gateway without exposing credentials', async () => {
  const bridge = (await createCodexToolGateway({ ...request,
    tools: { vibespace_context: false, 'plugins.list': true, 'plugins.run': true },
  }))!;
  expect(bridge).not.toBeNull();
  expect(bridge.dynamicTools?.map(tool => tool.name)).toEqual(['plugins_list', 'plugins_run']);
  bridge.bind('plugin-thread', identity, 'plugin-generation');
  await expect(bridge.executeTool?.('plugins_list', {}, 'plugin-list')).resolves.toMatchObject({ success: true });
  expect(state.execute).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'plugins.list', args: {} }));
  await expect(bridge.executeTool?.('plugins_run', { pluginId: 'github', operation: 'list_repositories', input: {} }, 'plugin-run')).resolves.toMatchObject({ success: true });
  expect(state.execute).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'plugins.run', args: { pluginId: 'github', operation: 'list_repositories', input: {} } }));
  bridge.dispose();
});

it('does not advertise or dispatch plugin mutation tools when the request disables them', async () => {
  const bridge = (await createCodexToolGateway({ ...request,
    tools: { vibespace_context: false, 'plugins.list': true, 'plugins.run': false },
  }))!;
  expect(bridge?.dynamicTools?.map(tool => tool.name)).toEqual(['plugins_list']);
  bridge.bind('plugin-thread', identity, 'plugin-generation');
  await expect(bridge.executeTool?.('plugins_run', { pluginId: 'github', operation: 'list_repositories' }, 'plugin-run')).rejects.toThrow('not enabled');
  expect(state.execute).not.toHaveBeenCalled();
  bridge.dispose();
});

it('exposes requested terminal and skill tools through the existing Codex gateway', async () => {
  const bridge = await createCodexToolGateway({ ...request,
    interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'full',
    tools: {
    vibespace_context: false, 'terminal.list': true, 'terminal.read': true,
    'terminal.write': true, 'skills.list': true, 'skills.load': true,
    'context.list': true, 'context.read': true,
  } });
  expect(bridge).not.toBeNull();
  expect(bridge!.toolNames).toEqual(['terminal_list', 'terminal_read', 'terminal_write', 'skills_list', 'skills_load', 'context_list', 'context_read']);
  bridge!.bind('coord-thread', identity, 'coord-generation');
  await bridge!.executeTool!('terminal_list', { limit: 10 }, 'list-call');
  expect(state.execute).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'terminal.list', sessionId: 'coord-thread', args: { limit: 10 } }));
  const command = 'Use RLM for MyProject; READ_ONLY.';
  await bridge!.executeTool!('terminal_write', { terminal: 'tty_verified', command }, 'write-call');
  expect(state.execute).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'terminal.write', args: { terminal: 'tty_verified', command } }));
  expect(state.grantMutation).toHaveBeenCalledWith(expect.objectContaining({
    requestId: 'write-call', sessionId: 'coord-thread', tool: 'terminal.write',
    args: { terminal: 'tty_verified', command },
  }), 'once');
  bridge!.dispose();
});

it('does not auto-grant terminal mutations for the reviewed Agent profile', async () => {
  const bridge = await createCodexToolGateway({ ...request,
    interactionMode: 'agent', accessLevel: 'full', agentApprovalMode: 'review',
    tools: { vibespace_context: false, 'terminal.write': true },
  });
  bridge!.bind('review-thread', identity, 'review-generation');
  await bridge!.executeTool!('terminal_write', { terminal: 'tty_verified', command: 'echo review' }, 'review-call');
  expect(state.grantMutation).not.toHaveBeenCalled();
  bridge!.dispose();
});

it('never grants unrequested writes or accepts malformed terminal selectors', async () => {
  const bridge = (await createCodexToolGateway({ ...request, tools: { vibespace_context: false, 'terminal.list': true, 'terminal.write': false } }))!;
  expect(bridge).not.toBeNull();
  bridge.bind('readonly-thread', identity, 'generation');
  await expect(bridge.executeTool!('terminal_write', { terminal: 'tty_verified', command: 'do work' }, 'denied')).rejects.toThrow('not enabled');
  expect(state.execute).not.toHaveBeenCalled();
  bridge.dispose();
});

it('keeps terminal gateway validation, cancellation and revocation before execution', async () => {
  const controller = new AbortController();
  state.enabled = false;
  const bridge = (await createCodexToolGateway({ ...request, signal: controller.signal,
    tools: { vibespace_context: false, 'terminal.write': true },
  }))!;
  expect(bridge).not.toBeNull();
  bridge.bind('write-thread', identity, 'generation');
  await expect(bridge.executeTool!('terminal_write', { terminal: { sessionId: 'wrong-shape' }, command: 'work' }, 'malformed')).rejects.toThrow();
  expect(state.execute).not.toHaveBeenCalled();
  state.authorized = false;
  await expect(bridge.executeTool!('terminal_write', { terminal: 'tty_verified', command: 'work' }, 'revoked')).rejects.toThrow('authority changed');
  expect(state.execute).not.toHaveBeenCalled();
  controller.abort();
  await expect(bridge.executeTool!('terminal_write', { terminal: 'tty_verified', command: 'work' }, 'cancelled')).rejects.toThrow('inactive');
  expect(state.execute).not.toHaveBeenCalled();
  bridge.dispose();
});

it('does not create a terminal bridge for a foreign project or a missing early authority', async () => {
  const tools = { vibespace_context: false, 'terminal.list': true };
  expect(await createCodexToolGateway({ ...request, tools, projectId: 'foreign' })).toBeNull();
  expect(await createCodexToolGateway({ ...request, tools, toolGatewayAuthority: null })).toBeNull();
});
