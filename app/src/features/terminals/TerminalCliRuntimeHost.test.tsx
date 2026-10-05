import * as React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCliRuntimeResponse } from './terminalCliRuntime';
import {
  observeCaoTerminalOpenCodeEvent,
  readCaoTerminalExecutionIdentity,
  resetCaoTerminalExecutionIdentityForTests,
} from '@/features/cao/terminalExecutionIdentity';
import type { CaoTerminalExecutionBinding } from '@/features/cao/terminalExecutionIdentity';
import type { ExpectedTerminalProcessBinding } from './terminalRefs';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: unknown }) => void),
  exitListener: null as null | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    if (event === 'terminal://exit') tauriMocks.exitListener = listener;
    else tauriMocks.listener = listener;
    return tauriMocks.unlisten;
  }),
}));

import { TerminalCliRuntimeHost } from './TerminalCliRuntimeHost';

function request(requestId = 'request-status', terminalSessionId = 'tty-a') {
  return {
    protocolVersion: 1,
    requestId,
    terminalSessionId,
    paneId: 'pane-a',
    projectId: 'project-a',
    method: 'status',
    params: {},
  };
}

const process: ExpectedTerminalProcessBinding = {
  projectId: 'project-a',
  processInstanceId: 'ptyproc-a',
  pid: 42,
  processStartedAt: 1_780_000_000_000,
  runtimeGeneration: 'runtime-a',
};

const binding: CaoTerminalExecutionBinding = {
  accountId: 'account-a',
  projectId: 'project-a',
  paneId: 'pane-a',
  sessionId: 'tty-a',
  process,
};

async function emit(payload: unknown): Promise<void> {
  await act(async () => {
    tauriMocks.listener?.({ payload });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function emitExit(payload: unknown): Promise<void> {
  await act(async () => {
    tauriMocks.exitListener?.({ payload });
    await Promise.resolve();
  });
}

describe('TerminalCliRuntimeHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.listener = null;
    tauriMocks.exitListener = null;
    tauriMocks.invoke.mockResolvedValue(undefined);
    resetCaoTerminalExecutionIdentityForTests();
  });

  it('routes a native event through the runtime and returns the exact bounded response', async () => {
    const response = Object.freeze({
      requestId: 'request-status',
      ok: true,
      code: 'ok',
      message: 'VibeSpace is running.',
    }) satisfies TerminalCliRuntimeResponse;
    const execute = vi.fn(async () => response);

    render(<TerminalCliRuntimeHost runtime={{ execute }} />);
    await act(async () => {
      await Promise.resolve();
    });
    await emit(request());

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-status',
        terminalSessionId: 'tty-a',
        method: 'status',
      }),
    );
    expect(tauriMocks.invoke).toHaveBeenCalledWith('terminal_cli_respond', { response });
  });

  it('fails a malformed native event closed without exposing its payload', async () => {
    const execute = vi.fn();
    render(<TerminalCliRuntimeHost runtime={{ execute }} />);
    await act(async () => {
      await Promise.resolve();
    });

    await emit({
      ...request('request-malformed'),
      nonce: 'must-not-cross',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('terminal_cli_respond', {
      response: {
        requestId: 'request-malformed',
        ok: false,
        code: 'invalid_request',
        message: 'The terminal CLI request is invalid.',
      },
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toContain('must-not-cross');
  });

  it('serializes requests from one terminal session and releases its listener on unmount', async () => {
    const releases: Array<() => void> = [];
    const execute = vi.fn(
      (input: { requestId: string }): Promise<TerminalCliRuntimeResponse> =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve({
              requestId: input.requestId,
              ok: true,
              code: 'ok',
              message: 'done',
            }),
          );
        }),
    );
    const mounted = render(<TerminalCliRuntimeHost runtime={{ execute }} />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      tauriMocks.listener?.({ payload: request('request-one') });
      tauriMocks.listener?.({ payload: request('request-two') });
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      releases[0]?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(2);

    mounted.unmount();
    expect(tauriMocks.unlisten).toHaveBeenCalledTimes(2);
  });

  it.each(['unmount', 'runtime replacement'] as const)(
    'does not execute queued requests after %s and allows a fresh host request', async (transition) => {
      let finishFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
      const response = (requestId: string): TerminalCliRuntimeResponse => ({
        requestId, ok: true, code: 'ok', message: 'done',
      });
      const oldExecute = vi.fn(async (input: { requestId: string }) => {
        if (input.requestId === 'first') await firstGate;
        return response(input.requestId);
      });
      const freshExecute = vi.fn(async (input: { requestId: string }) => response(input.requestId));
      const mounted = render(<TerminalCliRuntimeHost runtime={{ execute: oldExecute }} />);
      let activeMount = mounted;
      await act(async () => { await Promise.resolve(); });
      await emit(request('first'));
      await emit({ ...request('queued'), method: 'project.switch', params: { projectId: 'project-b' } });
      expect(oldExecute).toHaveBeenCalledTimes(1);

      if (transition === 'unmount') {
        mounted.unmount();
        activeMount = render(<TerminalCliRuntimeHost runtime={{ execute: freshExecute }} />);
      } else {
        mounted.rerender(<TerminalCliRuntimeHost runtime={{ execute: freshExecute }} />);
      }
      await act(async () => { await Promise.resolve(); });
      await emit(request('fresh'));
      expect(freshExecute).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishFirst();
        await firstGate;
      });

      expect(oldExecute).toHaveBeenCalledTimes(1);
      expect(tauriMocks.invoke).toHaveBeenCalledExactlyOnceWith('terminal_cli_respond', {
        response: response('fresh'),
      });
      activeMount.unmount();
    },
  );

  it('retires an exact CAO identity receipt when the native PTY exits', async () => {
    observeCaoTerminalOpenCodeEvent(
      binding,
      {
        type: 'step_start',
        sessionID: 'tty-a',
        part: { type: 'step-start', modelID: 'openai/gpt-5.6-luna', variant: 'high' },
      },
      100,
    );
    expect(readCaoTerminalExecutionIdentity(binding)).toBeDefined();

    const mounted = render(<TerminalCliRuntimeHost runtime={{ execute: vi.fn() }} />);
    await act(async () => {
      await Promise.resolve();
    });
    await emitExit({
      sessionId: 'tty-a',
      processInstanceId: 'ptyproc-a',
      pid: 42,
      processStartedAt: 1_780_000_000_000,
      runtimeGeneration: 'runtime-a',
    });

    expect(readCaoTerminalExecutionIdentity(binding)).toBeUndefined();
    mounted.unmount();
  });
});
