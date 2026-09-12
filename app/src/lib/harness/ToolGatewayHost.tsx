import * as React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  createProductionToolGatewayDependencies,
  installToolGatewayRlmContextPort,
} from './toolGatewayProduction';
import { productionRlmContextTool } from '@/features/context/contextRlmProduction';
import {
  parseToolGatewayRequest,
  type ToolGatewayRequest,
  type ToolGatewayResponse,
} from './toolGatewayProtocol';
import { createToolGatewayRuntime } from './toolGatewayRuntime';

const REQUEST_EVENT = 'vibespace://tool-gateway/request';
const RESPONSE_COMMAND = 'tool_gateway_respond';
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;

export type ToolGatewayRuntimePort = Readonly<{
  execute(request: ToolGatewayRequest): Promise<ToolGatewayResponse>;
}>;

export type ToolGatewayHostProps = Readonly<{
  runtime?: ToolGatewayRuntimePort;
}>;

function recoverRequestId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.getPrototypeOf(payload) !== Object.prototype) return null;
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'requestId');
  return descriptor?.enumerable &&
    'value' in descriptor &&
    typeof descriptor.value === 'string' &&
    SAFE_REQUEST_ID.test(descriptor.value)
    ? descriptor.value
    : null;
}

function invalidResponse(requestId: string): ToolGatewayResponse {
  return {
    requestId,
    ok: false,
    code: 'invalid_request',
    message: 'The semantic tool request is invalid.',
  };
}

async function respond(response: ToolGatewayResponse): Promise<void> {
  await invoke(RESPONSE_COMMAND, { response });
}

export function ToolGatewayHost({ runtime: suppliedRuntime }: ToolGatewayHostProps) {
  const runtime = React.useMemo(
    () => suppliedRuntime ?? createToolGatewayRuntime(createProductionToolGatewayDependencies()),
    [suppliedRuntime],
  );

  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const queues = new Map<string, Promise<void>>();
    const uninstallRlmContext = installToolGatewayRlmContextPort(productionRlmContextTool);

    const dispatch = async (request: ToolGatewayRequest): Promise<void> => {
      const response = await runtime.execute(request);
      if (!disposed) await respond(response);
    };

    void listen<unknown>(REQUEST_EVENT, ({ payload }) => {
      if (disposed) return;
      let request: ToolGatewayRequest;
      try {
        request = parseToolGatewayRequest(payload);
      } catch {
        const requestId = recoverRequestId(payload);
        if (requestId) void respond(invalidResponse(requestId)).catch(() => undefined);
        return;
      }
      if (request.tool === 'vibespace_context') {
        void dispatch(request).catch(() => undefined);
        return;
      }
      const previous = queues.get(request.sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => dispatch(request))
        .catch(() => undefined)
        .finally(() => {
          if (queues.get(request.sessionId) === next) queues.delete(request.sessionId);
        });
      queues.set(request.sessionId, next);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      uninstallRlmContext();
      queues.clear();
    };
  }, [runtime]);

  return null;
}
