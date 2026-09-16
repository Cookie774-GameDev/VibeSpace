import { beforeEach, expect, it, vi } from 'vitest';
import { createCodexContextTool, createCodexToolGateway } from './codexContextTool';
import type { ProviderRequest } from './types';

const state = vi.hoisted(() => ({
  enabled: true, authorized: true,
  execute: vi.fn(async () => ({ ok: true, data: { evidence: 'verified' } })),
  release: vi.fn(), observed: vi.fn(() => true),
}));
vi.mock('@/features/context/rlmPreferenceStore', () => ({ resolveRlmEnabled: () => ({ enabled: state.enabled }) }));
vi.mock('@/lib/harness/toolGatewayAuthority', () => ({
  captureToolGatewayAuthorityClaim: () => ({ scope: { accountId: 'account', workspaceId: 'workspace', projectId: 'project' }, generation: 1 }),
  bindToolGatewaySessionAuthority: () => state.authorized,
  bindToolGatewayObservedExecutionAuthority: state.observed,
  authorizeToolGatewayRequest: () => state.authorized,
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
beforeEach(() => { state.enabled = true; state.authorized = true; vi.clearAllMocks(); });

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
