import * as React from 'react';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  createTerminalCliRuntime,
  parseTerminalCliFrontendRequest,
  type TerminalCliFrontendRequest,
  type TerminalCliRuntimeResponse,
} from './terminalCliRuntime';
import { createProductionTerminalCliRuntimeDependencies } from './terminalCliProduction';
import { invalidateCaoTerminalExecutionIdentityOnExit } from '@/features/cao/terminalExecutionIdentity';

const REQUEST_EVENT = 'jarvis:terminal-cli-request';
const EXIT_EVENT = 'terminal://exit';
const RESPONSE_COMMAND = 'terminal_cli_respond';
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;

export type TerminalCliRuntimePort = Readonly<{
  execute(request: TerminalCliFrontendRequest): Promise<TerminalCliRuntimeResponse>;
}>;

export type TerminalCliRuntimeHostProps = Readonly<{
  runtime?: TerminalCliRuntimePort;
}>;

function invalidRequestId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'requestId');
  return descriptor &&
    descriptor.enumerable &&
    'value' in descriptor &&
    typeof descriptor.value === 'string' &&
    SAFE_REQUEST_ID.test(descriptor.value)
    ? descriptor.value
    : null;
}

function invalidResponse(requestId: string): TerminalCliRuntimeResponse {
  return Object.freeze({
    requestId,
    ok: false,
    code: 'invalid_request',
    message: 'The terminal CLI request is invalid.',
  });
}

function queueKey(request: TerminalCliFrontendRequest): string {
  return request.terminalSessionId
    ? `terminal:${request.terminalSessionId}`
    : request.paneId
      ? `pane:${request.paneId}`
      : `external:${request.projectId ?? 'active'}`;
}

async function respond(response: TerminalCliRuntimeResponse): Promise<void> {
  await invoke<void>(RESPONSE_COMMAND, { response });
}

export function TerminalCliRuntimeHost({ runtime: suppliedRuntime }: TerminalCliRuntimeHostProps) {
  const runtime = React.useMemo(
    () =>
      suppliedRuntime ?? createTerminalCliRuntime(createProductionTerminalCliRuntimeDependencies()),
    [suppliedRuntime],
  );

  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    const queues = new Map<string, Promise<void>>();

    const dispatch = async (request: TerminalCliFrontendRequest): Promise<void> => {
      const response = await appActivityLog.trace('terminal-command', request, () =>
        runtime.execute(request),
      );
      if (!disposed) await respond(response);
    };

    void listen<unknown>(REQUEST_EVENT, ({ payload }) => {
      if (disposed) return;
      let request: TerminalCliFrontendRequest;
      try {
        request = parseTerminalCliFrontendRequest(payload);
      } catch {
        const requestId = invalidRequestId(payload);
        if (requestId) void respond(invalidResponse(requestId)).catch(() => undefined);
        return;
      }

      appActivityLog.record('terminal-command', 'received', request);
      const key = queueKey(request);
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => dispatch(request))
        .catch(() => undefined)
        .finally(() => {
          if (queues.get(key) === next) queues.delete(key);
        });
      queues.set(key, next);
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => undefined);

    void listen<unknown>(EXIT_EVENT, ({ payload }) => {
      if (disposed) return;
      invalidateCaoTerminalExecutionIdentityOnExit(payload);
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlistenExit = stop;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenExit?.();
      queues.clear();
    };
  }, [runtime]);

  return null;
}
