import * as React from 'react';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readRelaySettings, subscribeRelaySettings } from '@/features/settings/relaySettings';
import { createRelayProductionClient } from '@/lib/relay/relayProductionClient';
import { RelayActiveContextHost } from '@/lib/relay/RelayActiveContextHost';
import {
  createProductionToolGatewayDependencies,
  installToolGatewayRelayPort,
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
const CANCEL_EVENT = 'vibespace://tool-gateway/cancel';
const RESPONSE_COMMAND = 'tool_gateway_respond';
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;

export type ToolGatewayRuntimePort = Readonly<{
  execute(
    request: ToolGatewayRequest,
    signal?: AbortSignal,
    isRequestLive?: () => Promise<boolean>,
  ): Promise<ToolGatewayResponse>;
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
    let unlisten: (() => void)[] = [];
    const queues = new Map<string, Promise<void>>();
    const requests = new Map<
      string,
      { request: ToolGatewayRequest; controller: AbortController }
    >();
    const uninstallRlmContext = installToolGatewayRlmContextPort(productionRlmContextTool);
    const relayClient =
      typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
        ? createRelayProductionClient({
            invoke: (command, args) => invoke(command, args),
            readSettings: readRelaySettings,
            subscribeSettings: subscribeRelaySettings,
            installPort: installToolGatewayRelayPort,
          })
        : null;
    relayClient?.start();

    const dispatch = async (entry: {
      request: ToolGatewayRequest;
      controller: AbortController;
    }): Promise<void> => {
      const { request, controller } = entry;
      const isRequestLive = async () => {
        if (disposed || controller.signal.aborted) return false;
        try {
          const live = await invoke<boolean>(RESPONSE_COMMAND, {
            probe: {
              requestId: request.requestId,
              sessionId: request.sessionId,
              messageId: request.messageId,
            },
          });
          if (live !== true) controller.abort();
          return live === true && !disposed && !controller.signal.aborted;
        } catch {
          controller.abort();
          return false;
        }
      };
      try {
        if (disposed || controller.signal.aborted) return;
        const response = await appActivityLog.trace('semantic-tool', request, () =>
          runtime.execute(request, controller.signal, isRequestLive),
        );
        if (!disposed && !controller.signal.aborted) await respond(response);
      } finally {
        if (requests.get(request.requestId) === entry) requests.delete(request.requestId);
      }
    };

    const cancelListener = listen<unknown>(CANCEL_EVENT, ({ payload }) => {
      if (disposed || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      if (Object.getPrototypeOf(payload) !== Object.prototype) return;
      const fields = Object.getOwnPropertyDescriptors(payload);
      if (Object.keys(fields).sort().join(',') !== 'messageId,requestId,sessionId') return;
      for (const field of Object.values(fields)) {
        if (
          !('value' in field) ||
          typeof field.value !== 'string' ||
          !SAFE_REQUEST_ID.test(field.value)
        )
          return;
      }
      const entry = requests.get(fields.requestId.value);
      if (
        !entry ||
        entry.request.sessionId !== fields.sessionId.value ||
        entry.request.messageId !== fields.messageId.value
      )
        return;
      entry.controller.abort();
      requests.delete(entry.request.requestId);
    });
    const requestListener = listen<unknown>(REQUEST_EVENT, ({ payload }) => {
      if (disposed) return;
      let request: ToolGatewayRequest;
      try {
        request = parseToolGatewayRequest(payload);
      } catch {
        const requestId = recoverRequestId(payload);
        if (requestId) void respond(invalidResponse(requestId)).catch(() => undefined);
        return;
      }
      // Native reservations are unique. A duplicate event cannot replace a live controller.
      if (requests.has(request.requestId)) return;
      const entry = { request, controller: new AbortController() };
      requests.set(request.requestId, entry);
      appActivityLog.record('semantic-tool', 'received', request);
      if (request.tool === 'vibespace_context') {
        void dispatch(entry).catch(() => undefined);
        return;
      }
      const previous = queues.get(request.sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => dispatch(entry))
        .catch(() => undefined)
        .finally(() => {
          if (queues.get(request.sessionId) === next) queues.delete(request.sessionId);
        });
      queues.set(request.sessionId, next);
    });
    void Promise.allSettled([cancelListener, requestListener]).then((results) => {
      const stops = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      if (disposed || results.some((result) => result.status === 'rejected')) {
        for (const entry of requests.values()) entry.controller.abort();
        requests.clear();
        for (const stop of stops) stop();
      } else unlisten = stops;
    });

    return () => {
      disposed = true;
      for (const stop of unlisten) stop();
      for (const entry of requests.values()) entry.controller.abort();
      requests.clear();
      uninstallRlmContext();
      void relayClient?.stop();
      queues.clear();
    };
  }, [runtime]);

  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? (
    <RelayActiveContextHost />
  ) : null;
}
