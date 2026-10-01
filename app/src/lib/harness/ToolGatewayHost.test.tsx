import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolGatewayResponse } from './toolGatewayProtocol';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: unknown }) => void),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    tauri.listeners.set(event, listener);
    if (event === 'vibespace://tool-gateway/request') tauri.listener = listener;
    return tauri.unlisten;
  }),
}));
const production = vi.hoisted(() => ({
  disposeRlm: vi.fn(),
  installRlm: vi.fn(() => production.disposeRlm),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('./toolGatewayProduction', () => ({
  createProductionToolGatewayDependencies: vi.fn(),
  installToolGatewayRlmContextPort: production.installRlm,
}));
vi.mock('@/features/context/contextRlmProduction', () => ({
  productionRlmContextTool: { execute: vi.fn() },
}));

import { ToolGatewayHost } from './ToolGatewayHost';

function request(requestId: string, sessionId = 'session-a') {
  return {
    protocolVersion: 1,
    requestId,
    sessionId,
    messageId: 'message-a',
    tool: 'app.getState',
    args: {},
    directory: 'C:\\work\\project',
  };
}

async function mounted(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emit(payload: unknown): Promise<void> {
  await act(async () => {
    tauri.listener?.({ payload });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ToolGatewayHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.listener = null;
    tauri.listeners.clear();
    tauri.invoke.mockResolvedValue(undefined);
  });

  it('mounts and disposes the production RLM context port with the gateway host', async () => {
    const view = render(<ToolGatewayHost runtime={{ execute: vi.fn() }} />);
    await mounted();
    expect(production.installRlm).toHaveBeenCalledOnce();
    expect(production.installRlm).toHaveBeenCalledWith(
      expect.objectContaining({ execute: expect.any(Function) }),
    );
    view.unmount();
    expect(production.disposeRlm).toHaveBeenCalledOnce();
  });

  it('installs one listener and returns exactly one bounded native response', async () => {
    const response: ToolGatewayResponse = {
      requestId: 'request-a',
      ok: true,
      code: 'ok',
      message: 'done',
      data: { route: 'chat' },
    };
    const execute = vi.fn(async () => response);
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await emit(request('request-a'));

    expect(tauri.listen).toHaveBeenCalledTimes(2);
    expect(tauri.listen).toHaveBeenCalledWith(
      'vibespace://tool-gateway/request',
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tool: 'app.getState' }), expect.any(AbortSignal), expect.any(Function));
    expect(tauri.invoke).toHaveBeenCalledOnce();
    expect(tauri.invoke).toHaveBeenCalledWith('tool_gateway_respond', { response });
  });

  it('dispatches a Tauri payload whose optional directory and worktree are null', async () => {
    const response: ToolGatewayResponse = {
      requestId: 'request-null-scope',
      ok: true,
      code: 'ok',
      message: 'done',
    };
    const execute = vi.fn(async () => response);
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await emit({
      ...request('request-null-scope'),
      directory: null,
      worktree: null,
    });

    expect(execute).toHaveBeenCalledWith({
      protocolVersion: 1,
      requestId: 'request-null-scope',
      sessionId: 'session-a',
      messageId: 'message-a',
      tool: 'app.getState',
      args: {},
    }, expect.any(AbortSignal), expect.any(Function));
    expect(tauri.invoke).toHaveBeenCalledWith('tool_gateway_respond', { response });
  });

  it('fails malformed requests closed and only recovers a safe own request ID', async () => {
    const execute = vi.fn();
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await emit({ ...request('request-b'), surprise: 'must-not-cross' });
    await emit({ ...request('../unsafe'), surprise: 'must-not-cross' });

    expect(execute).not.toHaveBeenCalled();
    expect(tauri.invoke).toHaveBeenCalledOnce();
    expect(tauri.invoke).toHaveBeenCalledWith('tool_gateway_respond', {
      response: {
        requestId: 'request-b',
        ok: false,
        code: 'invalid_request',
        message: 'The semantic tool request is invalid.',
      },
    });
    expect(JSON.stringify(tauri.invoke.mock.calls)).not.toContain('must-not-cross');
  });

  it('serializes one session while allowing independent sessions to run concurrently', async () => {
    const releases = new Map<string, () => void>();
    const execute = vi.fn(
      ({ requestId }: { requestId: string }): Promise<ToolGatewayResponse> =>
        new Promise((resolve) => {
          releases.set(requestId, () =>
            resolve({ requestId, ok: true, code: 'ok', message: 'done' }),
          );
        }),
    );
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();

    await act(async () => {
      tauri.listener?.({ payload: request('same-1', 'session-a') });
      tauri.listener?.({ payload: request('same-2', 'session-a') });
      tauri.listener?.({ payload: request('other-1', 'session-b') });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([value]) => value.requestId).sort()).toEqual([
      'other-1',
      'same-1',
    ]);

    await act(async () => {
      releases.get('same-1')?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('dispatches five same-session Context Map reads concurrently and correlates one response each', async () => {
    const releases = new Map<string, () => void>();
    const execute = vi.fn(
      ({ requestId }: { requestId: string }): Promise<ToolGatewayResponse> =>
        new Promise((resolve) => {
          releases.set(requestId, () =>
            resolve({
              requestId,
              ok: true,
              code: 'ok',
              message: 'done',
              data: { requestId },
            }),
          );
        }),
    );
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();

    await act(async () => {
      for (let index = 1; index <= 5; index += 1) {
        tauri.listener?.({
          payload: {
            ...request(`context-${index}`, 'session-context'),
            tool: 'vibespace_context',
            args: { operation: 'search', query: `question-${index}`, limit: 3 },
          },
        });
      }
      await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledTimes(5);
    expect([...releases.keys()].sort()).toEqual([
      'context-1',
      'context-2',
      'context-3',
      'context-4',
      'context-5',
    ]);

    await act(async () => {
      for (const release of releases.values()) release();
    });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(5));
    expect(
      tauri.invoke.mock.calls
        .map(([, { response }]) => (response as ToolGatewayResponse).requestId)
        .sort(),
    ).toEqual(['context-1', 'context-2', 'context-3', 'context-4', 'context-5']);
  });

  it('releases the listener and sends no late response after unmount', async () => {
    let release: ((response: ToolGatewayResponse) => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<ToolGatewayResponse>((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await act(async () => {
      tauri.listener?.({ payload: request('late') });
      await Promise.resolve();
    });
    view.unmount();
    expect(tauri.unlisten).toHaveBeenCalledTimes(2);

    await act(async () => {
      release?.({ requestId: 'late', ok: true, code: 'ok', message: 'done' });
      await Promise.resolve();
    });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('aborts only the matching native request and releases its queued successor without a late response', async () => {
    const signals = new Map<string, AbortSignal>();
    const execute = vi.fn(async (value: { requestId: string }, signal: AbortSignal): Promise<ToolGatewayResponse> => {
      signals.set(value.requestId, signal);
      if (value.requestId === 'waiting') await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { requestId: value.requestId, ok: true, code: 'ok', message: 'done' };
    });
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await emit(request('waiting'));
    await emit(request('next'));
    const cancel = tauri.listeners.get('vibespace://tool-gateway/cancel');
    await act(async () => cancel?.({ payload: { requestId: 'waiting', sessionId: 'foreign', messageId: 'message-a' } }));
    expect(signals.get('waiting')?.aborted).toBe(false);
    await act(async () => cancel?.({ payload: { requestId: 'waiting', sessionId: 'session-a', messageId: 'message-a' } }));
    expect(signals.get('waiting')?.aborted).toBe(true);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledOnce());
    expect(tauri.invoke).toHaveBeenCalledWith('tool_gateway_respond', { response: expect.objectContaining({ requestId: 'next' }) });
  });

  it('checks the exact native request before a protected execution and aborts when it is unavailable', async () => {
    let isLive!: () => Promise<boolean>;
    let signal!: AbortSignal;
    const execute = vi.fn(async (_value, lifetimeSignal, check) => {
      signal = lifetimeSignal;
      isLive = check;
      return { requestId: 'probe', ok: true, code: 'ok', message: 'done' };
    });
    render(<ToolGatewayHost runtime={{ execute }} />);
    await mounted();
    await emit(request('probe'));
    tauri.invoke.mockResolvedValueOnce(false);
    expect(await isLive()).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(tauri.invoke).toHaveBeenLastCalledWith('tool_gateway_respond', {
      probe: { requestId: 'probe', sessionId: 'session-a', messageId: 'message-a' },
    });
  });
});
