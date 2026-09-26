import { describe, expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';

describe('Codex native MCP status API', () => {
  it('requests the native status method and returns only names and typed connection states', async () => {
    const writes: Record<string, unknown>[] = [];
    const stopped: string[] = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async (_exe, owner, _model, route) => {
        expect(owner).toBe('vibespace-codex-mcp-status');
        expect(route).toEqual({ kind: 'official-codex', connectionId: 'openai-codex' });
        return { generation: 'mcp-status-generation' };
      },
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-mcp-status_list_1',
            result: {
              data: [
                {
                  name: 'docs',
                  runtimeStatus: 'connected',
                  authStatus: 'bearerToken',
                  serverInfo: { name: 'docs', version: '1.0', secret: 'must-not-escape' },
                  tools: { search: { name: 'search' } },
                  resources: [],
                  resourceTemplates: [],
                },
                {
                  name: 'offline',
                  runtimeStatus: null,
                  authStatus: 'unknown',
                  serverInfo: null,
                  tools: {},
                  resources: [],
                  resourceTemplates: [],
                },
              ],
              nextCursor: null,
            },
          };
        })(),
      }),
      write: async (_generation, frame) => {
        writes.push(frame);
      },
      stop: async (generation) => {
        stopped.push(generation);
        return true;
      },
    });

    await expect(adapter.listMcpServerStatus()).resolves.toEqual([
      { name: 'docs', runtimeStatus: 'connected' },
      { name: 'offline', runtimeStatus: null },
    ]);
    expect(writes).toEqual([
      {
        id: 'vibespace-codex-mcp-status_list_1',
        method: 'mcpServerStatus/list',
        params: { detail: 'toolsAndAuthOnly', limit: 100 },
      },
    ]);
    expect(stopped).toEqual(['mcp-status-generation']);
  });

  it('fails closed when the installed server rejects the native method', async () => {
    const writes: Record<string, unknown>[] = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'unsupported-mcp-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-mcp-status_list_1',
            error: { code: -32601, message: 'Method not found' },
          };
        })(),
      }),
      write: async (_generation, frame) => {
        writes.push(frame);
      },
      stop: async () => true,
    });

    await expect(adapter.listMcpServerStatus()).rejects.toThrow(
      /MCP server status request failed/u,
    );
    expect(writes.map((frame) => frame.method)).toEqual(['mcpServerStatus/list']);
  });

  it('times out an unanswered native status request, cleans its stream, and releases the lease', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      let firstSignal: AbortSignal | undefined;
      let firstStreamClosed = false;
      let signalWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      const stopped: string[] = [];
      const adapter = createCodexPersistentAdapter({
        findExecutable: async () => ({ executableId: 'official-codex' }),
        start: async () => ({ generation: `mcp-timeout-generation-${++attempt}` }),
        frames: (_generation, signal) => {
          const currentAttempt = attempt;
          if (currentAttempt === 1) firstSignal = signal;
          return {
            ready: Promise.resolve(),
            stream: (async function* () {
              try {
                yield { method: 'server/ready', params: {} };
                if (currentAttempt === 1) {
                  await new Promise<void>((resolve) =>
                    signal?.addEventListener('abort', () => resolve(), { once: true }),
                  );
                  return;
                }
                yield {
                  id: 'vibespace-codex-mcp-status_list_1',
                  result: { data: [], nextCursor: null },
                };
              } finally {
                if (currentAttempt === 1) firstStreamClosed = true;
              }
            })(),
          };
        },
        write: async () => {
          if (attempt === 1) signalWriteStarted();
        },
        stop: async (generation) => {
          stopped.push(generation);
          return true;
        },
      });

      const timedOut = adapter.listMcpServerStatus();
      const timedOutAssertion = expect(timedOut).rejects.toThrow(
        'Codex MCP status response timed out.',
      );
      await writeStarted;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
      await timedOutAssertion;
      expect(stopped).toEqual(['mcp-timeout-generation-1']);
      expect(firstSignal?.aborted).toBe(true);
      expect(firstStreamClosed).toBe(true);

      await expect(adapter.listMcpServerStatus()).resolves.toEqual([]);
      expect(stopped).toEqual(['mcp-timeout-generation-1', 'mcp-timeout-generation-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects duplicate server identities without returning partial data', async () => {
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'invalid-mcp-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-mcp-status_list_1',
            result: {
              data: [
                { name: 'docs', runtimeStatus: 'connected' },
                { name: 'docs', runtimeStatus: 'failed' },
              ],
              nextCursor: null,
            },
          };
        })(),
      }),
      write: async () => undefined,
      stop: async () => true,
    });

    await expect(adapter.listMcpServerStatus()).rejects.toThrow(/duplicate/u);
  });

  it('validates each status page and follows the native pagination cursor', async () => {
    const writes: Record<string, unknown>[] = [];
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'paged-mcp-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-mcp-status_list_1',
            result: { data: [{ name: 'alpha', runtimeStatus: 'starting' }], nextCursor: 'page-2' },
          };
          yield {
            id: 'vibespace-codex-mcp-status_list_2',
            result: { data: [{ name: 'beta', runtimeStatus: 'disabled' }], nextCursor: null },
          };
        })(),
      }),
      write: async (_generation, frame) => {
        writes.push(frame);
      },
      stop: async () => true,
    });

    await expect(adapter.listMcpServerStatus()).resolves.toEqual([
      { name: 'alpha', runtimeStatus: 'starting' },
      { name: 'beta', runtimeStatus: 'disabled' },
    ]);
    expect(writes[1]?.params).toEqual({ detail: 'toolsAndAuthOnly', limit: 100, cursor: 'page-2' });
  });

  it('rejects unrecognized native connection states', async () => {
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'official-codex' }),
      start: async () => ({ generation: 'invalid-mcp-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield {
            id: 'vibespace-codex-mcp-status_list_1',
            result: { data: [{ name: 'docs', runtimeStatus: 'secret' }], nextCursor: null },
          };
        })(),
      }),
      write: async () => undefined,
      stop: async () => true,
    });

    await expect(adapter.listMcpServerStatus()).rejects.toThrow(/runtime status is invalid/u);
  });
});
