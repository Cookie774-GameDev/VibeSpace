import { describe, expect, it, vi } from 'vitest';
import {
  createToolGatewayRuntime,
  ToolGatewaySemanticError,
  type ToolGatewayDependencies,
} from './toolGatewayRuntime';
import { parseToolGatewayRequest, type ToolGatewayTool } from './toolGatewayProtocol';

function dependencies(approved = true) {
  const call = vi.fn(async (args, context): Promise<unknown> => {
    if (args && typeof args === 'object' && 'connectionId' in args && 'toolName' in args) {
      return {
        result: {
          ok: true,
          contentTrust: 'external_untrusted',
          safeSummary: 'The test MCP tool completed.',
          textExcerpts: [],
          sourceRefs: [],
          artifacts: [],
          suggestedNextActions: [],
          omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
        },
        receipt: { status: 'succeeded' },
      };
    }
    return { args, context };
  });
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
    mcp: { list: call, run: call },
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
  'profile.allAboutMe.read': {},
  'profile.allAboutMe.update': { content: '# Me' },
  'memory.learning.read': {},
  'memory.learning.update': { content: 'fact', source: 'chat', confidence: 0.9 },
  'context.list': {},
  'context.read': { contextId: 'c-1' },
  'context.attach': { contextId: 'c-1' },
  vibespace_context: { operation: 'describe' },
  vibespace_context_search: { query: 'source' },
  vibespace_context_open: { pointer: { id: 'pointer', recordId: 'record', sourceVersion: 'rev', contentHash: 'a'.repeat(64), byteStart: 0, byteEnd: 8 } },
  vibespace_context_expand: { pointer: { id: 'pointer', recordId: 'record', sourceVersion: 'rev', contentHash: 'a'.repeat(64), byteStart: 0, byteEnd: 8 } },
  vibespace_context_address: { corpusId: 'mapped-source', position: '0' },
  vibespace_context_trace: { runId: 'rlm-executed' },
  'skills.list': {},
  'skills.load': { skillId: 's-1' },
  'plugins.list': {},
  'plugins.run': { pluginId: 'p-1', operation: 'status' },
  'mcp.list': {},
  'mcp.run': {
    connectionId: 'docs-server',
    toolName: 'search',
    classification: 'read',
    input: { query: 'VibeSpace' },
  },
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
  it('does not dispatch a tool whose individual native request already ended', async () => {
    const { call, deps } = dependencies();
    const transport = new AbortController();
    transport.abort();
    expect(await createToolGatewayRuntime(deps).execute(request('schedule.create'), transport.signal))
      .toMatchObject({ ok: false, code: 'cancelled' });
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['transport', 'owner'])('propagates %s cancellation into the same waiting handler', async (ended) => {
    const { call, deps } = dependencies();
    const owner = new AbortController();
    const transport = new AbortController();
    deps.readRequestSignal = () => owner.signal;
    call.mockImplementation(async (_args, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
    }));
    const task = createToolGatewayRuntime(deps).execute(request('schedule.create'), transport.signal);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][1].signal as AbortSignal;
    (ended === 'transport' ? transport : owner).abort();
    expect(signal.aborted).toBe(true);
    expect(await task).toMatchObject({ ok: false, code: 'cancelled' });
  });
  it('runs a trusted read-only plugin operation without granting mutations', async () => {
    const { call, deps } = dependencies(false);
    deps.plugins.isReadOnly = () => true;
    expect(await createToolGatewayRuntime(deps).execute(request('plugins.run')))
      .toMatchObject({ ok: true });
    expect(deps.authorizeMutation).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mutationApproved: false }));
  });

  it('requires mutation approval when the trusted plugin operation is not read-only', async () => {
    const { call, deps } = dependencies(false);
    deps.plugins.isReadOnly = () => false;
    expect(await createToolGatewayRuntime(deps).execute(request('plugins.run')))
      .toMatchObject({ ok: false, code: 'permission_denied' });
    expect(call).not.toHaveBeenCalled();
  });
  it('retains cancellation when provider cleanup releases the lease during authorization', async () => {
    const { call, deps } = dependencies();
    const owner = new AbortController();
    let bound: AbortSignal | undefined = owner.signal;
    Object.assign(deps, { readRequestSignal: () => bound });
    deps.authorizeRequest = async () => { owner.abort(); bound = undefined; return true; };
    expect(await createToolGatewayRuntime(deps).execute(request('mcp.run')))
      .toMatchObject({ ok: false, code: 'cancelled' });
    expect(call).not.toHaveBeenCalled();
  });
  it('does not dispatch a tool after its owner cancelled', async () => {
    const { call, deps } = dependencies();
    const owner = new AbortController();
    owner.abort();
    Object.assign(deps, { readRequestSignal: () => owner.signal });
    expect(await createToolGatewayRuntime(deps).execute(request('mcp.run')))
      .toMatchObject({ ok: false, code: 'cancelled' });
    expect(call).not.toHaveBeenCalled();
  });
  it('passes the authorized owner signal to MCP handlers without accepting it from arguments', async () => {
    const { call, deps } = dependencies();
    const owner = new AbortController();
    Object.assign(deps, { readRequestSignal: () => owner.signal });
    const runtime = createToolGatewayRuntime(deps);
    await runtime.execute(parseToolGatewayRequest({ protocolVersion: 1, requestId: 'cancel-request',
      sessionId: 'owned-session', messageId: 'owned-message', tool: 'mcp.run', args: argumentsByTool['mcp.run'] }));
    expect(call.mock.calls[0]?.[1].signal).toBe(owner.signal);
    owner.abort();
    expect(call.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
  it.each(Object.keys(argumentsByTool) as ToolGatewayTool[])(
    'dispatches %s through the fixed semantic dependency',
    async (tool) => {
      const { call, deps } = dependencies();
      const response = await createToolGatewayRuntime(deps).execute(request(tool));
      expect(response).toMatchObject({ requestId: request(tool).requestId, ok: true, code: 'ok' });
      expect(call).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledWith(
        request(tool).args,
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

  it('allows an approved read-only MCP invocation without mutation permission', async () => {
    const read = dependencies(false);
    const response = await createToolGatewayRuntime(read.deps).execute(request('mcp.run'));

    expect(response).toMatchObject({ ok: true, code: 'ok' });
    expect(read.deps.authorizeMutation).not.toHaveBeenCalled();
    expect(read.call).toHaveBeenCalledWith(
      argumentsByTool['mcp.run'],
      expect.objectContaining({ mutationApproved: false }),
    );
  });

  it('requires Tool Gateway approval for write and mutation MCP invocations', async () => {
    const writeRequest = (classification: 'write' | 'mutation') =>
      parseToolGatewayRequest({
        protocolVersion: 1,
        requestId: `request-mcp-${classification}`,
        sessionId: 'session-1',
        messageId: 'message-1',
        tool: 'mcp.run',
        args: { ...argumentsByTool['mcp.run'], classification },
      });

    const allowed = dependencies(true);
    await createToolGatewayRuntime(allowed.deps).execute(writeRequest('write'));
    expect(allowed.deps.authorizeMutation).toHaveBeenCalledWith(writeRequest('write'));
    expect(allowed.call).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'write' }),
      expect.objectContaining({ mutationApproved: true }),
    );

    const denied = dependencies(false);
    const response = await createToolGatewayRuntime(denied.deps).execute(
      writeRequest('mutation'),
    );
    expect(response).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(denied.call).not.toHaveBeenCalled();
  });

  it('fails closed when a non-data MCP classification tries to bypass approval', async () => {
    const denied = dependencies(false);
    let evaluated = false;
    const unsafeArgs = Object.defineProperty({}, 'classification', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return 'read';
      },
    });
    const response = await createToolGatewayRuntime(denied.deps).execute({
      ...request('mcp.run'),
      args: unsafeArgs,
    });

    expect(response).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(denied.call).not.toHaveBeenCalled();
    expect(evaluated).toBe(false);
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

  it('preserves a bounded typed semantic failure instead of erasing its recovery boundary', async () => {
    const { deps } = dependencies();
    deps.context.rlm = vi.fn(async () => {
      throw new ToolGatewaySemanticError({
        code: 'context_unavailable',
        message: 'Required VibeSpace project context was unavailable.',
        data: {
          grounded: false,
          safeFailure: 'retrieval-failed',
          receiptId: 'context-receipt-empty-first',
        },
      });
    });

    await expect(
      createToolGatewayRuntime(deps).execute(request('vibespace_context')),
    ).resolves.toEqual({
      requestId: 'request-vibespace_context',
      ok: false,
      code: 'context_unavailable',
      message: 'Required VibeSpace project context was unavailable.',
      data: {
        grounded: false,
        safeFailure: 'retrieval-failed',
        receiptId: 'context-receipt-empty-first',
      },
    });
  });

  it('projects normalized MCP failures to an outer failed envelope without secret-shaped data', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: false,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool reported an execution error.',
        textExcerpts: ['The upstream tool rejected the request.'],
        structuredData: { failureId: 'upstream-reject', token: '[REDACTED]' },
        sourceRefs: [{ uri: 'https://example.com/failure', name: 'Failure' }],
        artifacts: [{ kind: 'link', uri: 'https://example.com/failure', title: 'Failure' }],
        suggestedNextActions: ['Check the request and retry.'],
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: {
        receiptId: 'mcpinv_1000_1',
        connectionId: 'docs-server',
        toolName: 'search',
        status: 'failed',
        startedAt: 1_000,
        completedAt: 1_001,
      },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));

    expect(response).toMatchObject({
      requestId: 'request-mcp-run',
      ok: false,
      code: 'mcp_tool_failed',
      message: 'The external MCP tool reported an execution error.',
    });
    expect(JSON.stringify(response)).not.toContain('"token"');
    expect(JSON.stringify(response)).not.toContain('REDACTED');
    expect(response).toMatchObject({
      data: {
        result: {
          ok: false,
          contentTrust: 'external_untrusted',
          safeSummary: 'External MCP tool reported an execution error.',
          structuredData: { failureId: 'upstream-reject' },
          sourceRefs: [{ uri: 'https://example.com/failure', name: 'Failure' }],
          artifacts: [{ kind: 'link', uri: 'https://example.com/failure', title: 'Failure' }],
          suggestedNextActions: ['Check the request and retry.'],
        },
        receipt: { receiptId: 'mcpinv_1000_1', status: 'failed' },
      },
    });
  });

  it('preserves failed status when the gateway had to truncate an oversized MCP result', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: false,
        truncated: true,
        preview: 'oversized provider output preview',
      },
      receipt: {
        receiptId: 'mcpinv_1000_oversized_failure',
        connectionId: 'docs-server',
        toolName: 'search',
        status: 'failed',
        startedAt: 1_000,
        completedAt: 1_001,
      },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));

    expect(response).toMatchObject({
      requestId: 'request-mcp-run',
      ok: false,
      code: 'mcp_tool_failed',
      data: {
        result: {
          ok: false,
        },
        receipt: {
          receiptId: 'mcpinv_1000_oversized_failure',
          status: 'failed',
        },
      },
    });
  });

  it('projects normalized MCP successes without downgrading redacted structured data', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool completed with 1 text result.',
        textExcerpts: ['The upstream tool completed the request.'],
        structuredData: { answer: 42, nonce: 'AUDIT_SAFE_NONCE', token: '[REDACTED]' },
        sourceRefs: [{ uri: 'https://example.com/report', name: 'Report' }],
        artifacts: [{ kind: 'link', uri: 'https://example.com/report', title: 'Report' }],
        suggestedNextActions: ['Open https://example.com/report'],
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: {
        receiptId: 'mcpinv_1000_2',
        connectionId: 'docs-server',
        toolName: 'search',
        status: 'succeeded',
        startedAt: 1_000,
        completedAt: 1_001,
      },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));

    expect(response).toMatchObject({
      requestId: 'request-mcp-run',
      ok: true,
      code: 'ok',
    });
    expect(JSON.stringify(response)).not.toContain('"token"');
    expect(JSON.stringify(response)).not.toContain('REDACTED');
    expect(response).toMatchObject({
      data: {
        result: {
          ok: true,
          contentTrust: 'external_untrusted',
          safeSummary: 'External MCP tool completed with 1 text result.',
          structuredData: { answer: 42, nonce: 'AUDIT_SAFE_NONCE' },
          sourceRefs: [{ uri: 'https://example.com/report', name: 'Report' }],
          artifacts: [{ kind: 'link', uri: 'https://example.com/report', title: 'Report' }],
          suggestedNextActions: ['Open https://example.com/report'],
        },
        receipt: { receiptId: 'mcpinv_1000_2', status: 'succeeded' },
      },
    });
  });

  it('fails closed when the normalized result and receipt disagree or the receipt is cancelled', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'The provider returned a result.',
        structuredData: { answer: 42 },
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_mismatch', status: 'failed' },
    }));

    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false }, receipt: { status: 'failed' } },
    });

    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'The provider returned a result.',
        structuredData: { answer: 42 },
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_cancelled', status: 'cancelled' },
    }));

    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false }, receipt: { status: 'cancelled' } },
    });
  });

  it('counts scalar truncation and invalid optional fields, bounds seeded counters, and redacts URL credentials', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: `See https://user:synthetic-secret@example.com/report/${'x'.repeat(1_100)}`,
        textExcerpts: [`Open https://user:synthetic-secret@example.com/report/${'x'.repeat(1_100)}`],
        sourceRefs: 'not-an-array',
        artifacts: { invalid: true },
        suggestedNextActions: ['Visit https://user:synthetic-secret@example.com/report'],
        omitted: {
          inlineMedia: Number.MAX_SAFE_INTEGER,
          unsafeReferences: Number.MAX_SAFE_INTEGER,
          truncatedValues: Number.MAX_SAFE_INTEGER,
        },
      },
      receipt: {
        receiptId: `https://user:synthetic-secret@example.com/${'x'.repeat(300)}`,
        status: 'succeeded',
      },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));
    const serialized = JSON.stringify(response);
    expect(response).toMatchObject({ ok: true, code: 'ok' });
    expect(serialized).not.toContain('synthetic-secret');
    const result = (response.data as { result: {
      omitted: { inlineMedia: number; unsafeReferences: number; truncatedValues: number };
      sourceRefs: unknown;
      artifacts: unknown;
    } }).result;
    expect(result.omitted.inlineMedia).toBeLessThanOrEqual(1_000_000);
    expect(result.omitted.unsafeReferences).toBeLessThanOrEqual(1_000_000);
    expect(result.omitted.truncatedValues).toBeLessThanOrEqual(1_000_000);
    expect(result.omitted.truncatedValues).toBeGreaterThan(1_000_000 - 10);
    expect(result.sourceRefs).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it('does not evaluate accessor or class instances while projecting MCP payloads', async () => {
    const { deps } = dependencies();
    let evaluated = false;
    const accessorResult = Object.defineProperty({}, 'structuredData', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return { answer: 42 };
      },
    });
    class ProviderResult {
      readonly ok = true;
      readonly contentTrust = 'external_untrusted';
      readonly safeSummary = 'provider result';
    }
    deps.mcp.run = vi.fn(async () => ({
      result: accessorResult,
      receipt: { receiptId: 'mcpinv_accessor', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });
    expect(evaluated).toBe(false);

    deps.mcp.run = vi.fn(async () => ({
      result: new ProviderResult(),
      receipt: { receiptId: 'mcpinv_class', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });

    deps.mcp.run = vi.fn(async () => ({
      result: [],
      receipt: { receiptId: 'mcpinv_array', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });

    deps.mcp.run = vi.fn(async () => ({
      receipt: { receiptId: 'mcpinv_missing_result', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });

    deps.mcp.run = vi.fn(async () => ({
      result: { safeSummary: 'provider result without boolean status' },
      receipt: { receiptId: 'mcpinv_missing_ok', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });

    deps.mcp.run = vi.fn(async () => ({
      result: { ok: 'false', safeSummary: 'provider result with malformed status' },
      receipt: { receiptId: 'mcpinv_string_ok', status: 'succeeded' },
    }));
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });

    let envelopeEvaluated = false;
    const accessorEnvelope = Object.defineProperty({}, 'result', {
      enumerable: true,
      get: () => {
        envelopeEvaluated = true;
        return { ok: true };
      },
    });
    deps.mcp.run = vi.fn(async () => accessorEnvelope);
    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });
    expect(envelopeEvaluated).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['string', 'provider primitive result'],
  ] as const)('fails closed when mcp.run returns a primitive %s instead of an envelope', async (_label, value) => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => value);

    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: false,
      code: 'mcp_tool_failed',
      data: { result: { ok: false } },
    });
  });

  it('projects structured-only MCP successes with safe structured data and actions', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool completed with structured data.',
        textExcerpts: [],
        structuredData: { answer: 42, nonce: 'AUDIT_STRUCTURED_ONLY' },
        suggestedNextActions: ['Use the returned answer.'],
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_structured_only', status: 'succeeded' },
    }));

    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        result: {
          structuredData: { answer: 42, nonce: 'AUDIT_STRUCTURED_ONLY' },
          suggestedNextActions: ['Use the returned answer.'],
        },
      },
    });
  });

  it('projects link-only MCP successes with bounded source references and artifacts', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool returned one source.',
        textExcerpts: [],
        sourceRefs: [
          {
            uri: 'https://example.com/report?view=full',
            name: 'Report',
            title: 'Audit report',
            mimeType: 'text/html',
          },
        ],
        artifacts: [
          {
            kind: 'link',
            uri: 'https://example.com/report?view=full',
            title: 'Audit report',
            mimeType: 'text/html',
          },
        ],
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_link_only', status: 'succeeded' },
    }));

    await expect(createToolGatewayRuntime(deps).execute(request('mcp.run'))).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        result: {
          sourceRefs: [
            {
              uri: 'https://example.com/report?view=full',
              name: 'Report',
              title: 'Audit report',
              mimeType: 'text/html',
            },
          ],
          artifacts: [
            {
              kind: 'link',
              uri: 'https://example.com/report?view=full',
              title: 'Audit report',
              mimeType: 'text/html',
            },
          ],
        },
      },
    });
  });

  it('bounds oversized MCP payload collections while retaining useful safe entries', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool returned many bounded values.',
        textExcerpts: [],
        sourceRefs: Array.from({ length: 20 }, (_, index) => ({
          uri: `https://example.com/report/${index}`,
          name: `Report ${index}`,
        })),
        artifacts: Array.from({ length: 20 }, (_, index) => ({
          kind: 'link',
          uri: `https://example.com/report/${index}`,
          title: `Report ${index}`,
        })),
        suggestedNextActions: Array.from({ length: 12 }, (_, index) => `Open report ${index}`),
        structuredData: { answer: 42, rows: Array.from({ length: 40 }, (_, index) => index) },
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_oversized_success', status: 'succeeded' },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));
    expect(response).toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        result: {
          sourceRefs: expect.arrayContaining([
            { uri: 'https://example.com/report/0', name: 'Report 0' },
          ]),
          artifacts: expect.arrayContaining([
            { kind: 'link', uri: 'https://example.com/report/0', title: 'Report 0' },
          ]),
          suggestedNextActions: expect.arrayContaining(['Open report 0']),
          structuredData: { answer: 42 },
        },
      },
    });
    const result = (response.data as { result: {
      sourceRefs: unknown[];
      artifacts: unknown[];
      suggestedNextActions: unknown[];
      structuredData: { rows: unknown[] };
      omitted: { truncatedValues: number };
    } }).result;
    expect(result.sourceRefs).toHaveLength(16);
    expect(result.artifacts).toHaveLength(16);
    expect(result.suggestedNextActions).toHaveLength(8);
    expect(result.structuredData.rows).toHaveLength(24);
    expect(result.omitted.truncatedValues).toBeGreaterThan(0);
  });

  it('omits secret-bearing link and structured fields without losing safe MCP content', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'External MCP tool completed with safe and sensitive fields.',
        textExcerpts: [],
        sourceRefs: [
          {
            uri: 'https://example.com/report?token=synthetic-secret&view=full',
            name: 'Report',
          },
          {
            uri: 'https://example.com/sk-proj-synthetic-path-token-1234567890/report',
            name: 'Unsafe report',
          },
        ],
        artifacts: [
          {
            kind: 'link',
            uri: 'https://example.com/sk-proj-synthetic-path-token-1234567890/report',
            title: 'Unsafe report',
          },
        ],
        structuredData: {
          answer: 42,
          apiKey: '[REDACTED]',
          nested: { state: 'ready', accessToken: '[REDACTED]' },
        },
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_secret_fields', status: 'succeeded' },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));
    expect(response).toMatchObject({
      ok: true,
      code: 'ok',
      data: {
        result: {
          structuredData: { answer: 42, nested: { state: 'ready' } },
          sourceRefs: [{ uri: 'https://example.com/report?view=full', name: 'Report' }],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('synthetic-secret');
    expect(JSON.stringify(response)).not.toContain('sk-proj-');
    expect(JSON.stringify(response)).not.toContain('apiKey');
    expect(JSON.stringify(response)).not.toContain('accessToken');
    expect((response.data as { result: { omitted: { unsafeReferences: number; truncatedValues: number } } }).result.omitted).toMatchObject({
      unsafeReferences: 2,
    });
  });

  it('keeps the projected MCP envelope below the protocol cap for combined safe fields', async () => {
    const { deps } = dependencies();
    deps.mcp.run = vi.fn(async () => ({
      result: {
        ok: true,
        contentTrust: 'external_untrusted',
        safeSummary: 'Large but safe MCP result.',
        textExcerpts: Array.from({ length: 8 }, (_, index) => `excerpt-${index}-${'x'.repeat(1_000)}`),
        sourceRefs: Array.from({ length: 16 }, (_, index) => ({
          uri: `https://example.com/report/${index}/${'x'.repeat(1_900)}`,
          name: `Report ${index}`,
          title: `Title ${index}`,
        })),
        artifacts: Array.from({ length: 16 }, (_, index) => ({
          kind: 'link',
          uri: `https://example.com/artifact/${index}/${'x'.repeat(1_900)}`,
          title: `Artifact ${index}`,
        })),
        suggestedNextActions: Array.from({ length: 8 }, (_, index) => `Open report ${index}-${'x'.repeat(280)}`),
        structuredData: {
          answer: 42,
          nonce: 'AUDIT_COMBINED_SAFE',
          rows: Array.from({ length: 24 }, (_, index) => ({
            index,
            value: 'x'.repeat(2_000),
          })),
        },
        omitted: { inlineMedia: 0, unsafeReferences: 0, truncatedValues: 0 },
      },
      receipt: { receiptId: 'mcpinv_combined_safe', status: 'succeeded' },
    }));

    const response = await createToolGatewayRuntime(deps).execute(request('mcp.run'));

    expect(response).toMatchObject({ ok: true, code: 'ok' });
    expect(JSON.stringify(response).length).toBeLessThan(128 * 1024);
    expect(response).toMatchObject({
      data: {
        result: {
          ok: true,
          structuredData: {
            answer: 42,
            nonce: 'AUDIT_COMBINED_SAFE',
          },
        },
      },
    });
    expect(
      (response.data as { result: { omitted: { truncatedValues: number } } }).result.omitted
        .truncatedValues,
    ).toBeGreaterThan(0);
  });
});
