import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent } from './types';
import { createCodexPersistentAdapter, resolveCodexExecutable } from './codexPersistent';

const connection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-app-server',
  providerId: 'openai',
  displayName: 'Codex',
  mode: 'external-cli',
  authSource: 'codex-cli-session',
  promptTransport: 'native-system',
  enabled: true,
  capabilities: {
    text: true,
    images: false,
    files: true,
    tools: true,
    modelSelection: true,
    structuredOutput: true,
    streaming: true,
    cancellation: true,
    resumeSession: true,
    systemPrompt: true,
    workingDirectory: true,
    usage: true,
    subscriptionQuota: false,
    localOnly: false,
  },
};

async function* frames(
  usageUpdates: Array<Record<string, unknown>> = [],
  threadOptions: Readonly<{
    approvalPolicy?: string;
    sandbox?: Record<string, unknown>;
    reasoningEffort?: string | null;
  }> = {},
) {
  yield {
    id: 'request_1_model_1',
    result: {
      data: [
        {
          model: 'gpt-5.6-luna',
          supportedReasoningEfforts: [],
          serviceTiers: [],
        },
      ],
      nextCursor: null,
    },
  };
  yield {
    id: 'request_1_thread',
    result: {
      thread: { id: 'thread_native_1' },
      model: 'gpt-5.6-luna',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: 'C:\\workspace',
      approvalPolicy: threadOptions.approvalPolicy ?? 'never',
      approvalsReviewer: 'user',
      sandbox: threadOptions.sandbox ?? { type: 'readOnly', networkAccess: false },
      reasoningEffort: threadOptions.reasoningEffort ?? null,
    },
  };
  yield {
    method: 'turn/started',
    params: {
      threadId: 'thread_native_1',
      turn: { id: 'turn_native_1' },
    },
  };
  yield {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      itemId: 'message_native_1',
      delta: 'Working on it.',
    },
  };
  yield {
    method: 'item/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      item: {
        id: 'command_native_1',
        type: 'commandExecution',
        status: 'completed',
        commandActions: [{ type: 'read', path: 'C:\\workspace\\game.js' }],
        exitCode: 0,
      },
    },
  };
  for (const tokenUsage of usageUpdates) {
    yield { method: 'thread/tokenUsage/updated', params: {
      threadId: 'thread_native_1', turnId: 'turn_native_1', tokenUsage,
    } };
  }
  yield {
    method: 'turn/completed',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      turn: { id: 'turn_native_1', status: 'completed' },
    },
  };
}



it.each(['valid', 'wrong-thread', 'wrong-turn', 'wrong-tool'])('scopes native dynamic Context calls (%s)', async (kind) => {
  const writes: Array<Record<string, any>> = [];
  const bridge = { bind: vi.fn(), dispose: vi.fn(), execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'verified evidence' }] })) };
  const adapter = createCodexPersistentAdapter({
    contextTool: async () => bridge,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      for await (const frame of frames()) {
        yield frame;
        if ('method' in frame && frame.method === 'turn/started') yield {
          id: 'dynamic_1', method: 'item/tool/call', params: {
            threadId: kind === 'wrong-thread' ? 'foreign' : 'thread_native_1',
            turnId: kind === 'wrong-turn' ? 'foreign' : 'turn_native_1',
            tool: kind === 'wrong-tool' ? 'exec_command' : 'vibespace_context',
            namespace: null, callId: 'context_call_1', arguments: { operation: 'investigate', query: 'current retention' },
          },
        };
      }
    })() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  const events: ProviderEvent[] = [];
  const run = async () => { for await (const event of adapter.send!({
    requestId: 'request_1', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' }, chatId: 'chat', prompt: 'Audit the Context Map',
    modelId: 'gpt-5.6-luna', workingDirectory: 'C:\\workspace', interactionMode: 'ask',
  })) events.push(event); };
  if (kind !== 'valid') {
    await expect(run()).rejects.toThrow('invalid turn or tool binding');
    expect(bridge.execute).not.toHaveBeenCalled();
  } else {
    await run();
    expect(writes.find(x => x.method === 'thread/start')?.params.dynamicTools[0].name).toBe('vibespace_context');
    expect(bridge.bind).toHaveBeenCalledWith('thread_native_1', expect.objectContaining({ model: 'gpt-5.6-luna' }), 'generation');
    expect(writes.find(x => x.id === 'dynamic_1')?.result.contentItems[0].text).toBe('verified evidence');
    expect(events.filter(x => x.type === 'tool' && x.name === 'vibespace_context').map(x => x.type === 'tool' && x.status)).toEqual(['started', 'completed']);
    const completed = events.find(
      (x): x is Extract<ProviderEvent, { type: 'tool' }> =>
        x.type === 'tool' && x.name === 'vibespace_context' && x.status === 'completed',
    );
    // The visible card must carry arguments AND the executed result, not
    // arguments alone (the arguments-without-results gap from the N32 audit).
    expect(completed?.details).toMatchObject({
      arguments: { operation: 'investigate', query: 'current retention' },
    });
    expect(JSON.stringify(completed?.details)).toContain('verified evidence');
  }
  expect(bridge.dispose).toHaveBeenCalledOnce();
});

it('advertises and dispatches explicitly enabled semantic MCP tools through the existing gateway', async () => {
  const writes: Array<Record<string, any>> = [];
  const bridge = {
    dynamicTools: [
      { type: 'function' as const, name: 'mcp_list', description: 'List approved MCP tools.', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'mcp_run', description: 'Run one approved MCP tool.', inputSchema: { type: 'object' } },
    ],
    bind: vi.fn(),
    execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'context' }] })),
    executeTool: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: JSON.stringify({
      requestId: 'mcp_call_1',
      ok: true,
      code: 'ok',
      data: {
        result: {
          ok: true,
          contentTrust: 'external_untrusted',
          safeSummary: 'MCP fixture result.',
          textExcerpts: ['fixture text'],
          sourceRefs: [{ uri: 'https://example.com/report', name: 'Report' }],
          artifacts: [{ kind: 'link', uri: 'https://example.com/report', title: 'Report' }],
          suggestedNextActions: ['Review the report.'],
          structuredData: { answer: 42, nonce: 'fixture_nonce' },
          omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
        },
        receipt: { status: 'succeeded' },
      },
    }) }] })),
    dispose: vi.fn(),
  };
  const adapter = createCodexPersistentAdapter({
    contextTool: async () => bridge,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation-mcp' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      for await (const frame of frames()) {
        yield frame;
        if ('method' in frame && frame.method === 'turn/started') yield {
          id: 'mcp_dynamic_1', method: 'item/tool/call', params: {
            threadId: 'thread_native_1', turnId: 'turn_native_1', tool: 'mcp_list',
            namespace: null, callId: 'mcp_call_1', arguments: {},
          },
        };
      }
    })() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  const events: ProviderEvent[] = [];
  for await (const event of adapter.send!({
    requestId: 'request_1', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' }, chatId: 'chat-mcp', accountId: 'account',
    workspaceId: 'workspace', projectId: 'project', prompt: 'List approved MCP tools.',
    modelId: 'gpt-5.6-luna', workingDirectory: 'C:\\workspace',
    interactionMode: 'ask', tools: { 'mcp.list': true, 'mcp.run': true },
  })) events.push(event);

  expect(writes.find((x) => x.method === 'thread/start')?.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual([
    'mcp_list', 'mcp_run',
  ]);
  expect(bridge.executeTool).toHaveBeenCalledWith('mcp_list', {}, 'mcp_call_1');
  expect(bridge.execute).not.toHaveBeenCalled();
  expect(writes.find((x) => x.id === 'mcp_dynamic_1')?.result.contentItems[0].text).toContain('structuredData');
  expect(events.filter((event) => event.type === 'tool' && event.name === 'mcp_list').map((event) => event.type === 'tool' && event.status)).toEqual(['started', 'completed']);
  const completed = events.find(
    (event): event is Extract<ProviderEvent, { type: 'tool' }> =>
      event.type === 'tool' && event.name === 'mcp_list' && event.status === 'completed',
  );
  expect(completed?.details?.result).toMatchObject({
    data: {
      result: {
        sourceRefs: [{ uri: 'https://example.com/report', name: 'Report' }],
        artifacts: [{ kind: 'link', uri: 'https://example.com/report', title: 'Report' }],
        suggestedNextActions: ['Review the report.'],
        structuredData: { answer: 42, nonce: 'fixture_nonce' },
      },
    },
  });
  expect(bridge.dispose).toHaveBeenCalledOnce();
});

it('forwards plugin tool flags to the native thread and projects a plugin result', async () => {
  const writes: Array<Record<string, any>> = [];
  const bridge = {
    dynamicTools: [
      { type: 'function' as const, name: 'plugins_list', description: 'List connected plugins.', inputSchema: { type: 'object' } },
      { type: 'function' as const, name: 'plugins_run', description: 'Run a connected plugin operation.', inputSchema: { type: 'object' } },
    ],
    bind: vi.fn(),
    execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'context' }] })),
    executeTool: vi.fn(async (toolName: string, args: unknown) => ({
      success: true,
      contentItems: [{
        type: 'inputText' as const,
        text: JSON.stringify({ toolName, args, ok: true, plugin: 'github', operation: 'list_repositories' }),
      }],
    })),
    dispose: vi.fn(),
  };
  const contextTool = vi.fn(async (request: { tools?: Readonly<Record<string, boolean>> }) => {
    expect(request.tools?.['plugins.list']).toBe(true);
    expect(request.tools?.['plugins.run']).toBe(true);
    return bridge;
  });
  const adapter = createCodexPersistentAdapter({
    contextTool,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation-plugin' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      for await (const frame of frames([], {
        approvalPolicy: 'on-request',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: ['C:\\workspace'],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        reasoningEffort: 'low',
      })) {
        yield frame;
        if ('method' in frame && frame.method === 'turn/started') yield {
          id: 'plugin_dynamic_1', method: 'item/tool/call', params: {
            threadId: 'thread_native_1', turnId: 'turn_native_1', tool: 'plugins_run',
            namespace: null, callId: 'plugin_call_1',
            arguments: { pluginId: 'github', operation: 'list_repositories', input: {} },
          },
        };
      }
    })() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  const events: ProviderEvent[] = [];
  for await (const event of adapter.send!({
    requestId: 'request_1', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' }, chatId: 'chat-plugin', accountId: 'account',
    workspaceId: 'workspace', projectId: 'project', prompt: 'Use the connected GitHub plugin.',
    modelId: 'gpt-5.6-luna', workingDirectory: 'C:\\workspace', interactionMode: 'agent',
    tools: { 'plugins.list': true, 'plugins.run': true },
  })) events.push(event);

  expect(contextTool).toHaveBeenCalledWith(expect.objectContaining({
    tools: { 'plugins.list': true, 'plugins.run': true },
  }));
  expect(writes.find((x) => x.method === 'thread/start')?.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual([
    'plugins_list', 'plugins_run',
  ]);
  expect(bridge.executeTool).toHaveBeenCalledWith(
    'plugins_run',
    { pluginId: 'github', operation: 'list_repositories', input: {} },
    'plugin_call_1',
  );
  expect(writes.find((x) => x.id === 'plugin_dynamic_1')?.result.contentItems[0].text).toContain('list_repositories');
  expect(events.filter((event) => event.type === 'tool' && event.name === 'plugins_run').map((event) => event.type === 'tool' && event.status)).toEqual(['started', 'completed']);
  expect(bridge.dispose).toHaveBeenCalledOnce();
});

it('does not advertise a disabled plugin mutation tool to native Codex', async () => {
  const writes: Array<Record<string, any>> = [];
  const bridge = {
    dynamicTools: [
      { type: 'function' as const, name: 'plugins_list', description: 'List connected plugins.', inputSchema: { type: 'object' } },
    ],
    bind: vi.fn(),
    execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'context' }] })),
    executeTool: vi.fn(),
    dispose: vi.fn(),
  };
  const contextTool = vi.fn(async (request: { tools?: Readonly<Record<string, boolean>> }) => {
    expect(request.tools?.['plugins.list']).toBe(true);
    expect(request.tools?.['plugins.run']).toBe(false);
    return bridge;
  });
  const adapter = createCodexPersistentAdapter({
    contextTool,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation-plugin-disabled' }),
    frames: () => ({ ready: Promise.resolve(), stream: frames() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  for await (const _event of adapter.send!({
    requestId: 'request_1', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' }, chatId: 'chat-plugin-disabled', accountId: 'account',
    workspaceId: 'workspace', projectId: 'project', prompt: 'List connected plugins.',
    modelId: 'gpt-5.6-luna', workingDirectory: 'C:\\workspace', interactionMode: 'ask',
    tools: { 'plugins.list': true, 'plugins.run': false },
  })) { /* consume */ }
  expect(writes.find((x) => x.method === 'thread/start')?.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual(['plugins_list']);
  expect(bridge.executeTool).not.toHaveBeenCalled();
  expect(bridge.dispose).toHaveBeenCalledOnce();
});

it('resumes a legacy persisted Codex thread without a capability receipt and keeps its context tools bound', async () => {
  const writes: Array<Record<string, any>> = [];
  const bridge = {
    dynamicTools: [
      { type: 'function' as const, name: 'mcp_list', description: 'List approved MCP tools.', inputSchema: { type: 'object' } },
    ],
    bind: vi.fn(),
    execute: vi.fn(async () => ({ success: true, contentItems: [{ type: 'inputText' as const, text: 'context' }] })),
    executeTool: vi.fn(),
    dispose: vi.fn(),
  };
  const accountId = 'legacy-resume-account';
  const chatId = 'legacy-resume-chat';
  const key = 'vibespace.codex-context-thread.v1:' + JSON.stringify([
    accountId, 'workspace', 'project', chatId, 'C:\\workspace',
  ]);
  localStorage.setItem(key, 'thread_legacy');
  const adapter = createCodexPersistentAdapter({
    contextTool: async () => bridge,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'generation-legacy-resume' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      yield { id: 'request_legacy_model_1', result: { data: [{ model: 'gpt-5.6-luna', supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null } };
      yield { id: 'request_legacy_resume', result: {
        thread: { id: 'thread_legacy' }, model: 'gpt-5.6-luna', modelProvider: 'openai', serviceTier: null,
        cwd: 'C:\\workspace', approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null,
      } };
      yield { method: 'turn/started', params: { threadId: 'thread_legacy', turn: { id: 'turn_legacy' } } };
      yield { method: 'turn/completed', params: { threadId: 'thread_legacy', turnId: 'turn_legacy', turn: { id: 'turn_legacy', status: 'completed' } } };
    })() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  try {
    for await (const _event of adapter.send!({
      requestId: 'request_legacy', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' },
      sessionId: 'thread_legacy', expectedSessionId: 'thread_legacy',
      chatId, accountId, workspaceId: 'workspace', projectId: 'project', prompt: 'Continue the legacy task.',
      modelId: 'gpt-5.6-luna', workingDirectory: 'C:\\workspace', interactionMode: 'ask',
      tools: { 'mcp.list': true },
    })) { /* consume */ }
    expect(writes.map((frame) => frame.method)).toEqual(['model/list', 'thread/resume', 'turn/start']);
    expect(writes.find((frame) => frame.method === 'thread/start')).toBeUndefined();
    expect(writes.find((frame) => frame.method === 'thread/resume')?.params).not.toHaveProperty('dynamicTools');
    expect(writes.find((frame) => frame.method === 'turn/start')?.params.input[0].text).toBe('Continue the legacy task.');
    expect(bridge.bind).toHaveBeenCalledWith('thread_legacy', expect.objectContaining({ model: 'gpt-5.6-luna' }), 'generation-legacy-resume');
  } finally {
    localStorage.removeItem(key);
  }
});

it('does not implicitly resume a thread whose dynamic tool manifest is unknown', async () => {
  const writes: Array<any> = [];
  const bridge = { dynamicTools: [{ type: 'function' as const, name: 'terminal_list', description: 'Read live targets', inputSchema: { type: 'object' } }], toolNames: ['terminal_list' as const], bind: vi.fn(), execute: vi.fn(), executeTool: vi.fn(), dispose: vi.fn() };
  const scope = ['tool-change-account', 'workspace', 'project', 'tool-change-chat', 'C:\\workspace'];
  const oldKey = 'vibespace.codex-context-thread.v1:' + JSON.stringify(scope);
  localStorage.setItem(oldKey, 'thread_old_context_only');
  const adapter = createCodexPersistentAdapter({
    contextTool: async () => bridge,
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'tool-change-generation' }),
    frames: () => ({ ready: Promise.resolve(), stream: (async function* () {
      yield { id: 'request_changed_model_1', result: { data: [{ model: 'gpt-5.6-luna', supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null } };
      yield { id: 'request_changed_thread', result: { thread: { id: 'thread_new' }, model: 'gpt-5.6-luna', modelProvider: 'openai', serviceTier: null, cwd: 'C:\\workspace', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null } };
      yield { method: 'turn/started', params: { threadId: 'thread_new', turn: { id: 'turn_new' } } };
      yield { method: 'turn/completed', params: { threadId: 'thread_new', turnId: 'turn_new', turn: { id: 'turn_new', status: 'completed' } } };
    })() }),
    write: async (_generation, frame) => { writes.push(frame); }, stop: async () => true,
  });
  try {
    for await (const _event of adapter.send!({ requestId: 'request_changed', connection, codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' }, accountId: scope[0], workspaceId: scope[1], projectId: scope[2], chatId: scope[3], workingDirectory: scope[4], prompt: 'Verify the existing workers.', modelId: 'gpt-5.6-luna', interactionMode: 'ask', tools: { 'terminal.list': true } })) { /* consume */ }
    expect(writes.some(frame => frame.method === 'thread/resume')).toBe(false);
    expect(writes.find(frame => frame.method === 'thread/start')?.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual(['terminal_list']);
    expect(localStorage.getItem(oldKey)).toBe('thread_old_context_only');
  } finally { localStorage.removeItem(oldKey); }
});
