import {
  KERNEL_BRIDGE_VERSION,
  KERNEL_CLIENT_RESPONSE_EVENT,
  isKernelClientRequestRegistration,
  isKernelClientRequestV1,
  isKernelClientResponseEvent,
  responseMatchesKernelRequest,
  unavailableKernelResponse,
  type KernelClientRequestRegistration,
  type KernelClientRequestV1,
  type KernelClientResponseEvent,
  type KernelClientResponseV1,
} from './kernelBridgeProtocol';
import { requestLocalJarvisKernelHost } from './kernelHost';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

type RequestInput<K extends KernelClientRequestV1['kind']> = Omit<
  Extract<KernelClientRequestV1, { kind: K }>,
  'version' | 'kind'
>;

type WireResponseFor<K extends KernelClientRequestV1['kind']> = Extract<
  KernelClientResponseV1,
  | { kind: 'unavailable' }
  | {
      kind: K extends 'turn_dispatch'
        ? 'turn_accepted'
        : K extends 'approval_create'
          ? 'approval_created'
          : K extends 'approval_present'
            ? 'approval_presentation'
            : K extends 'approval_status'
              ? 'approval_state'
              : K extends 'approval_decide'
                ? 'approval_decided'
                : K extends 'approval_execute'
                  ? 'approval_execution'
                  : K extends 'cancel'
                    ? 'cancellation_state'
                    : K extends 'scheduled_retry'
                      ? 'retry_state'
                      : K extends 'run_ownership_diagnostic' ? 'run_ownership_diagnostic' : K extends 'context_source_revision' ? 'context_source_revision' : 'command_center_snapshot';
    }
>;

/** nativeHostEpoch is client metadata from the validated broker envelope, never a DTO input. */
type ResponseFor<K extends KernelClientRequestV1['kind']> = K extends 'context_source_revision' | 'run_ownership_diagnostic'
  ? Extract<KernelClientResponseV1, { kind: 'unavailable' }> | (Extract<KernelClientResponseV1, { kind: K }> & Readonly<{ nativeHostEpoch: number }>)
  : WireResponseFor<K>;
export interface JarvisKernelClient {
  getRunOwnershipDiagnostic(input: RequestInput<'run_ownership_diagnostic'>): Promise<ResponseFor<'run_ownership_diagnostic'>>;
  getContextSourceRevision(input: RequestInput<'context_source_revision'>): Promise<ResponseFor<'context_source_revision'>>;
  dispatchTurn(input: RequestInput<'turn_dispatch'>): Promise<ResponseFor<'turn_dispatch'>>;
  createApproval(input: RequestInput<'approval_create'>): Promise<ResponseFor<'approval_create'>>;
  getApprovalPresentation(
    input: RequestInput<'approval_present'>,
  ): Promise<ResponseFor<'approval_present'>>;
  getApprovalStatus(
    input: RequestInput<'approval_status'>,
  ): Promise<ResponseFor<'approval_status'>>;
  decideApproval(input: RequestInput<'approval_decide'>): Promise<ResponseFor<'approval_decide'>>;
  executeApproval(
    input: RequestInput<'approval_execute'>,
  ): Promise<ResponseFor<'approval_execute'>>;
  cancel(input: RequestInput<'cancel'>): Promise<ResponseFor<'cancel'>>;
  retryScheduled(input: RequestInput<'scheduled_retry'>): Promise<ResponseFor<'scheduled_retry'>>;
  getCommandCenterSnapshot(
    input: RequestInput<'command_center_snapshot'>,
  ): Promise<ResponseFor<'command_center_snapshot'>>;
  dispose(): void;
}

interface PendingRequest {
  request: KernelClientRequestV1;
  finish(response: KernelClientResponseV1): void;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let nativeTransportPromise:
  | Promise<{
      invoke: typeof import('@tauri-apps/api/core').invoke;
      listen: typeof import('@tauri-apps/api/event').listen;
    }>
  | undefined;

function loadNativeTransport() {
  nativeTransportPromise ??= Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]).then(([core, event]) => ({ invoke: core.invoke, listen: event.listen }));
  return nativeTransportPromise;
}

function normalizedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.trunc(value ?? DEFAULT_TIMEOUT_MS)));
}

function buildRequest<K extends KernelClientRequestV1['kind']>(
  kind: K,
  input: RequestInput<K>,
): Extract<KernelClientRequestV1, { kind: K }> {
  return Object.freeze({ version: KERNEL_BRIDGE_VERSION, kind, ...input }) as Extract<
    KernelClientRequestV1,
    { kind: K }
  >;
}

export function createJarvisKernelClient(options?: { timeoutMs?: number }): JarvisKernelClient {
  const timeoutMs = normalizedTimeout(options?.timeoutMs);
  const pending = new Set<PendingRequest>();
  let disposed = false;

  async function send<K extends KernelClientRequestV1['kind']>(
    request: Extract<KernelClientRequestV1, { kind: K }>,
  ): Promise<ResponseFor<K>> {
    if (!isKernelClientRequestV1(request)) {
      return unavailableKernelResponse(request, 'invalid_response') as ResponseFor<K>;
    }
    if (disposed) {
      return unavailableKernelResponse(request, 'client_disposed') as ResponseFor<K>;
    }
    const localResponse = (request.kind === 'context_source_revision' || request.kind === 'run_ownership_diagnostic') ? null : requestLocalJarvisKernelHost(request);
    if (localResponse) {
      return localResponse
        .then((response) =>
          responseMatchesKernelRequest(request, response)
            ? (response as ResponseFor<K>)
            : (unavailableKernelResponse(request, 'invalid_response') as ResponseFor<K>),
        )
        .catch(() => unavailableKernelResponse(request, 'invalid_response') as ResponseFor<K>);
    }
    if (!isTauriRuntime()) {
      return unavailableKernelResponse(request, 'host_unavailable') as ResponseFor<K>;
    }

    const { invoke, listen } = await loadNativeTransport();
    if (disposed) {
      return unavailableKernelResponse(request, 'client_disposed') as ResponseFor<K>;
    }

    return new Promise<ResponseFor<K>>((resolve) => {
      let settled = false;
      let registration: KernelClientRequestRegistration | null = null;
      let unlisten: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const earlyEvents: KernelClientResponseEvent[] = [];

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const remove = unlisten;
        unlisten = null;
        if (remove) {
          try {
            void Promise.resolve(remove()).catch(() => undefined);
          } catch {
            // The request is already settled; listener cleanup remains fail-closed.
          }
        }
        pending.delete(pendingRequest);
      };
      const finish = (response: KernelClientResponseV1, nativeHostEpoch?: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (response.kind === 'context_source_revision' || response.kind === 'run_ownership_diagnostic') {
          if (!Number.isSafeInteger(nativeHostEpoch) || nativeHostEpoch! <= 0) {
            resolve(unavailableKernelResponse(request, 'invalid_response') as ResponseFor<K>);
          } else {
            resolve(Object.freeze({ ...response, nativeHostEpoch: nativeHostEpoch! }) as ResponseFor<K>);
          }
        } else resolve(response as ResponseFor<K>);
      };
      const pendingRequest: PendingRequest = { request, finish };
      pending.add(pendingRequest);

      const consume = (candidate: unknown) => {
        if (settled || !isKernelClientResponseEvent(candidate)) return;
        if (!registration) {
          earlyEvents.push(candidate);
          return;
        }
        if (
          candidate.epoch !== registration.epoch ||
          candidate.requestId !== registration.requestId
        ) {
          return;
        }
        if (!responseMatchesKernelRequest(request, candidate.response)) {
          finish(unavailableKernelResponse(request, 'invalid_response'));
          return;
        }
        finish(candidate.response, registration.epoch);
      };

      void listen<KernelClientResponseEvent>(KERNEL_CLIENT_RESPONSE_EVENT, (event) => {
        consume(event.payload);
      })
        .then((remove) => {
          if (settled) {
            try {
              void Promise.resolve(remove()).catch(() => undefined);
            } catch {
              // The request was already settled before listener installation completed.
            }
            return;
          }
          unlisten = remove;
          if (disposed) {
            finish(unavailableKernelResponse(request, 'client_disposed'));
            return;
          }
          return invoke<unknown>('kernel_client_request', { request, timeoutMs });
        })
        .then((result) => {
          if (settled || result === undefined) return;
          if (!isKernelClientRequestRegistration(result)) {
            finish(unavailableKernelResponse(request, 'invalid_response'));
            return;
          }
          registration = result;
          const remaining = Math.max(0, registration.deadlineMs - Date.now());
          timer = setTimeout(
            () => finish(unavailableKernelResponse(request, 'request_timed_out')),
            Math.min(timeoutMs, remaining),
          );
          for (const event of earlyEvents.splice(0)) consume(event);
        })
        .catch(() => finish(unavailableKernelResponse(request, 'host_unavailable')));
    });
  }

  return Object.freeze({
    getRunOwnershipDiagnostic: (input: RequestInput<'run_ownership_diagnostic'>) => send(buildRequest('run_ownership_diagnostic', input)),
    dispatchTurn: (input: RequestInput<'turn_dispatch'>) =>
      send(buildRequest('turn_dispatch', input)),
    createApproval: (input: RequestInput<'approval_create'>) =>
      send(buildRequest('approval_create', input)),
    getApprovalPresentation: (input: RequestInput<'approval_present'>) =>
      send(buildRequest('approval_present', input)),
    getApprovalStatus: (input: RequestInput<'approval_status'>) =>
      send(buildRequest('approval_status', input)),
    decideApproval: (input: RequestInput<'approval_decide'>) =>
      send(buildRequest('approval_decide', input)),
    executeApproval: (input: RequestInput<'approval_execute'>) =>
      send(buildRequest('approval_execute', input)),
    cancel: (input: RequestInput<'cancel'>) => send(buildRequest('cancel', input)),
    retryScheduled: (input: RequestInput<'scheduled_retry'>) =>
      send(buildRequest('scheduled_retry', input)),
    getCommandCenterSnapshot: (input: RequestInput<'command_center_snapshot'>) =>
      send(buildRequest('command_center_snapshot', input)),
    getContextSourceRevision: (input: RequestInput<'context_source_revision'>) =>
      send(buildRequest('context_source_revision', input)),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const request of [...pending]) {
        request.finish(unavailableKernelResponse(request.request, 'client_disposed'));
      }
    },
  });
}
