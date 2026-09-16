import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection, ProviderEvent } from './types';
import { createCodexPersistentAdapter, resolveCodexExecutable } from './codexPersistent';

const connection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-app-server',
  providerId: 'opencode-go',
  displayName: 'Codex via OpenCodex',
  mode: 'external-cli',
  authSource: 'opencode-provider-session',
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

async function* frames(usageUpdates: Array<Record<string, unknown>> = []) {
  yield {
    id: 'request_1_model_1',
    result: {
      data: [
        {
          model: 'opencode-go/deepseek-v4-flash-vision-exp',
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
      model: 'opencode-go/deepseek-v4-flash-vision-exp',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: 'C:\\workspace',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: null,
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
    requestId: 'request_1', connection, chatId: 'chat', prompt: 'Audit the Context Map',
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp', workingDirectory: 'C:\\workspace', interactionMode: 'ask',
  })) events.push(event); };
  if (kind !== 'valid') {
    await expect(run()).rejects.toThrow('invalid turn or tool binding');
    expect(bridge.execute).not.toHaveBeenCalled();
  } else {
    await run();
    expect(writes.find(x => x.method === 'thread/start')?.params.dynamicTools[0].name).toBe('vibespace_context');
    expect(bridge.bind).toHaveBeenCalledWith('thread_native_1', expect.objectContaining({ model: 'opencode-go/deepseek-v4-flash-vision-exp' }), 'generation');
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
    requestId: 'request_1', connection, chatId: 'chat-mcp', accountId: 'account',
    workspaceId: 'workspace', projectId: 'project', prompt: 'List approved MCP tools.',
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp', workingDirectory: 'C:\\workspace',
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
