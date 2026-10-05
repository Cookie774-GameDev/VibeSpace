import {
  KERNEL_HOST_REQUEST_EVENT,
  isKernelClientRequestV1,
  isKernelClientResponseV1,
  isKernelHostRequestEvent,
  responseMatchesKernelRequest,
  unavailableKernelResponse,
  type KernelClientRequestV1,
  type KernelClientResponseV1,
} from './kernelBridgeProtocol';

const BROWSER_HOST_LOCK = 'vibespace.jarvis.kernel-host.v1';

export interface JarvisKernelHostRuntime {
  handleRequest(request: KernelClientRequestV1): Promise<KernelClientResponseV1>;
  invalidateAccount(accountId: string): void;
  dispose(): void | Promise<void>;
}

export type JarvisKernelHostSession =
  | Readonly<{
      role: 'host';
      invalidateAccount(accountId: string): void;
      dispose(): Promise<void>;
    }>
  | Readonly<{ role: 'unavailable'; reason: 'host_unavailable' }>;

export interface StartJarvisKernelHostOptions {
  createRuntime(): JarvisKernelHostRuntime | Promise<JarvisKernelHostRuntime>;
}

interface NativeHostRegistration {
  epoch: number;
  ownerToken: string;
}

let nativeHostTransportPromise:
  | Promise<{
      invoke: typeof import('@tauri-apps/api/core').invoke;
      listen: typeof import('@tauri-apps/api/event').listen;
    }>
  | undefined;
let hostLifecycleTail: Promise<void> = Promise.resolve();
type LocalHostRequest = (request: KernelClientRequestV1) => Promise<KernelClientResponseV1>;
let localHostRequest: LocalHostRequest | null = null;

const SAFE_KERNEL_FAILURE_CODES = new Set([
  'kernel_account_authority_revoked',
  'kernel_account_binding_invalid',
  'kernel_action_decide_checkpoint_failed',
  'kernel_action_decide_decision_failed',
  'kernel_action_decide_finalize_failed',
  'kernel_action_decide_scope_failed',
  'kernel_action_scope_mismatch',
  'kernel_action_response_checkpoint_conflict',
  'kernel_action_response_checkpoint_missing',
  'kernel_action_response_finalize_account_authority_revoked',
  'kernel_action_response_finalize_conflict',
  'kernel_action_response_finalize_integrity_error',
  'kernel_event_sequence_invalid',
]);

const SAFE_REPOSITORY_FAILURE_CODES = new Set([
  'account_scope_mismatch',
  'parent_run_not_found',
  'run_id_conflict',
  'event_idempotency_conflict',
  'transition_event_requires_atomic_run_update',
  'live_evidence_integrity_error',
  'transport_attempt_integrity_error',
  'attempt_effect_integrity_error',
  'profile_integrity_error',
  'artifact_integrity_error',
  'approval_integrity_error',
  'approval_scope_mismatch',
  'approval_status_conflict',
  'invalid_limit',
]);

/** @internal Emits only stable codes; never forwards arbitrary error text or data. */
export function sanitizeKernelHostFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    SAFE_KERNEL_FAILURE_CODES.has(error.message) &&
    error.message.length <= 96
  ) {
    return error.message;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'name') === 'JarvisRepositoryError'
  ) {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && SAFE_REPOSITORY_FAILURE_CODES.has(code)) return code;
  }
  return 'unclassified';
}

type NativeKernelHostStartupStage =
  | 'native_transport'
  | 'native_listener'
  | 'native_registration'
  | 'runtime_creation';

const SAFE_KERNEL_STARTUP_FAILURE_CODES: ReadonlySet<string> = new Set([
  'kernel_host_wrong_window',
  'kernel_host_token_invalid',
  'kernel_host_epoch_exhausted',
  'kernel_host_identity_exhausted',
  'kernel_host_state_unavailable',
  'kernel_host_registration_invalid',
  'kernel_local_host_already_installed',
  'jarvis_kernel_host_already_installed',
  'jarvis_plugin_artifact_authority_unavailable',
]);

function sanitizeKernelHostStartupFailureCode(error: unknown): string {
  try {
    // Native invokes reject with strings; JS errors have an own data message.
    // Never call error getters, stringify unknown values, or include payloads.
    const message =
      typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null
          ? Object.getOwnPropertyDescriptor(error, 'message')?.value
          : undefined;
    if (message === 'current webview is not a WebviewWindow') return 'webview_window_unavailable';
    if (typeof message === 'string' && SAFE_KERNEL_STARTUP_FAILURE_CODES.has(message))
      return message;
  } catch {
    // A hostile proxy cannot turn diagnostic inspection into a startup failure.
  }
  return 'unclassified';
}

function reportKernelHostStartupFailure(stage: NativeKernelHostStartupStage, error: unknown): void {
  try {
    console.error('[jarvis-kernel] startup failed', {
      stage,
      code: sanitizeKernelHostStartupFailureCode(error),
    });
  } catch {
    // Observation must not bypass listener cleanup, epoch release, or fallback.
  }
}

async function observeNativeHostStartup<T>(
  stage: NativeKernelHostStartupStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    reportKernelHostStartupFailure(stage, error);
    throw error;
  }
}

function loadNativeHostTransport() {
  nativeHostTransportPromise ??= Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]).then(([core, event]) => ({ invoke: core.invoke, listen: event.listen }));
  return nativeHostTransportPromise;
}

function runCleanup(cleanup: () => unknown): void {
  try {
    void Promise.resolve(cleanup()).catch(() => undefined);
  } catch {
    // Cleanup is best-effort; native ownership is still released below.
  }
}

function nativeRegistration(value: unknown): NativeHostRegistration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' || !descriptors[key].enumerable || !('value' in descriptors[key]),
    )
  ) {
    return null;
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
  if (Object.keys(record).length !== 2) return null;
  if (!Number.isSafeInteger(record.epoch) || Number(record.epoch) <= 0) return null;
  if (typeof record.ownerToken !== 'string' || record.ownerToken.length < 16) return null;
  return { epoch: Number(record.epoch), ownerToken: record.ownerToken };
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isBrowserAuxiliarySurface(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  if (params.get('workbench') === '1') return true;
  return ['dictation', 'pet-overlay', 'pet-mini-panel'].includes(params.get('view') ?? '');
}

export function createUnavailableKernelHostRuntime(): JarvisKernelHostRuntime {
  return Object.freeze({
    handleRequest: async (request: KernelClientRequestV1) =>
      unavailableKernelResponse(request, 'kernel_not_activated'),
    invalidateAccount: (_accountId: string) => {},
    dispose: () => {},
  });
}

async function handleValidatedHostRequest(
  runtime: JarvisKernelHostRuntime,
  request: KernelClientRequestV1,
): Promise<KernelClientResponseV1> {
  try {
    const candidate = await runtime.handleRequest(request);
    return isKernelClientResponseV1(candidate) && responseMatchesKernelRequest(request, candidate)
      ? candidate
      : unavailableKernelResponse(request, 'invalid_response');
  } catch (error) {
    console.error('[jarvis-kernel] request failed', {
      requestKind: request.kind,
      code: sanitizeKernelHostFailureCode(error),
    });
    return unavailableKernelResponse(request, 'invalid_response');
  }
}

function installLocalHostRequest(runtime: JarvisKernelHostRuntime): () => Promise<void> {
  if (localHostRequest) throw new Error('kernel_local_host_already_installed');
  let live = true;
  let requestTail: Promise<void> = Promise.resolve();
  const request: LocalHostRequest = (input) => {
    const response = requestTail.then(() =>
      live
        ? handleValidatedHostRequest(runtime, input)
        : unavailableKernelResponse(input, 'host_released'),
    );
    requestTail = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  };
  localHostRequest = request;
  return async () => {
    live = false;
    if (localHostRequest === request) localHostRequest = null;
    await requestTail;
  };
}

/** @internal Closed DTO path available only inside the already-attested host realm. */
export function requestLocalJarvisKernelHost(
  request: KernelClientRequestV1,
): Promise<KernelClientResponseV1> | null {
  if (!isKernelClientRequestV1(request)) return null;
  return localHostRequest?.(request) ?? null;
}

async function startNativeHost(
  options: StartJarvisKernelHostOptions,
): Promise<JarvisKernelHostSession> {
  const { invoke, listen } = await observeNativeHostStartup(
    'native_transport',
    loadNativeHostTransport,
  );
  let runtime: JarvisKernelHostRuntime | null = null;
  let registration: NativeHostRegistration | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let releaseLocalHostRequest: (() => Promise<void>) | null = null;
  let requestQueue: Promise<void> = Promise.resolve();
  let resolveRuntimeReady: (runtime: JarvisKernelHostRuntime | null) => void = () => {};
  const runtimeReady = new Promise<JarvisKernelHostRuntime | null>((resolve) => {
    resolveRuntimeReady = resolve;
  });

  const unlisten = await observeNativeHostStartup('native_listener', () =>
    listen(KERNEL_HOST_REQUEST_EVENT, (event) => {
      const payload = event.payload;
      requestQueue = requestQueue.then(async () => {
        const activeRuntime = await runtimeReady;
        const activeRegistration = registration;
        if (
          disposed ||
          !activeRuntime ||
          !activeRegistration ||
          !isKernelHostRequestEvent(payload) ||
          payload.epoch !== activeRegistration.epoch
        ) {
          return;
        }
        const response = await handleValidatedHostRequest(activeRuntime, payload.request);
        if (disposed) return;
        await invoke('kernel_host_respond', {
          epoch: activeRegistration.epoch,
          ownerToken: activeRegistration.ownerToken,
          requestId: payload.requestId,
          response,
        }).catch(() => undefined);
      });
    }),
  );

  let startupStage: NativeKernelHostStartupStage = 'native_registration';
  try {
    registration = nativeRegistration(await invoke('register_kernel_host'));
    if (!registration) throw new Error('kernel_host_registration_invalid');
    startupStage = 'runtime_creation';
    runtime = await options.createRuntime();
    releaseLocalHostRequest = installLocalHostRequest(runtime);
    resolveRuntimeReady(runtime);
  } catch (error) {
    reportKernelHostStartupFailure(startupStage, error);
    disposed = true;
    resolveRuntimeReady(null);
    runCleanup(unlisten);
    if (registration) {
      await invoke('release_kernel_host', {
        epoch: registration.epoch,
        ownerToken: registration.ownerToken,
      }).catch(() => undefined);
    }
    await Promise.resolve(runtime?.dispose()).catch(() => undefined);
    runtime = null;
    return Object.freeze({ role: 'unavailable', reason: 'host_unavailable' });
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    disposePromise = (async () => {
      runCleanup(unlisten);
      const releaseLocal = releaseLocalHostRequest;
      releaseLocalHostRequest = null;
      const localRelease = releaseLocal?.();
      await requestQueue.catch(() => undefined);
      await localRelease?.catch(() => undefined);
      const runtimeToDispose = runtime;
      let teardownError: unknown;
      try {
        await runtimeToDispose?.dispose();
      } catch (cause) {
        teardownError = cause;
      }
      const activeRegistration = registration;
      registration = null;
      runtime = null;
      if (activeRegistration) {
        await invoke('release_kernel_host', {
          epoch: activeRegistration.epoch,
          ownerToken: activeRegistration.ownerToken,
        }).catch(() => undefined);
      }
      if (teardownError !== undefined) throw teardownError;
    })();
    return disposePromise;
  };
  const onPageHide = () => {
    void dispose().catch(() => undefined);
  };
  window.addEventListener('pagehide', onPageHide);

  return Object.freeze({
    role: 'host' as const,
    invalidateAccount: (accountId: string) => {
      if (!disposed && accountId.trim()) runtime?.invalidateAccount(accountId);
    },
    dispose,
  });
}

async function startBrowserHost(
  options: StartJarvisKernelHostOptions,
): Promise<JarvisKernelHostSession> {
  if (!navigator.locks?.request) {
    return Object.freeze({ role: 'unavailable', reason: 'host_unavailable' });
  }

  let resolveStart: (session: JarvisKernelHostSession) => void = () => {};
  const started = new Promise<JarvisKernelHostSession>((resolve) => {
    resolveStart = resolve;
  });
  let runtime: JarvisKernelHostRuntime | null = null;
  let releaseLocalHostRequest: (() => Promise<void>) | null = null;
  let disposed = false;
  let releaseLock: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const lockRequest = navigator.locks
    .request(
      BROWSER_HOST_LOCK,
      { mode: 'exclusive', ifAvailable: true, steal: false },
      async (lock) => {
        if (!lock) {
          resolveStart(Object.freeze({ role: 'unavailable', reason: 'host_unavailable' }));
          return;
        }
        try {
          runtime = await options.createRuntime();
          releaseLocalHostRequest = installLocalHostRequest(runtime);
        } catch {
          await Promise.resolve(runtime?.dispose()).catch(() => undefined);
          runtime = null;
          resolveStart(Object.freeze({ role: 'unavailable', reason: 'host_unavailable' }));
          return;
        }
        const dispose = async () => {
          if (disposed) return lockRequest;
          disposed = true;
          window.removeEventListener('pagehide', onPageHide);
          const releaseLocal = releaseLocalHostRequest;
          releaseLocalHostRequest = null;
          await releaseLocal?.().catch(() => undefined);
          const runtimeToDispose = runtime;
          let teardownError: unknown;
          try {
            await runtimeToDispose?.dispose();
          } catch (cause) {
            teardownError = cause;
          } finally {
            runtime = null;
            releaseLock();
          }
          await lockRequest.catch(() => undefined);
          if (teardownError !== undefined) throw teardownError;
        };
        const onPageHide = () => {
          void dispose().catch(() => undefined);
        };
        window.addEventListener('pagehide', onPageHide);
        resolveStart(
          Object.freeze({
            role: 'host' as const,
            invalidateAccount: (accountId: string) => {
              if (!disposed && accountId.trim()) runtime?.invalidateAccount(accountId);
            },
            dispose,
          }),
        );
        await released;
        runtime = null;
      },
    )
    .catch(() => {
      resolveStart(Object.freeze({ role: 'unavailable', reason: 'host_unavailable' }));
    });

  return started;
}

async function startExclusiveHost(
  start: () => Promise<JarvisKernelHostSession>,
): Promise<JarvisKernelHostSession> {
  const predecessor = hostLifecycleTail;
  let releaseLifecycle: () => void = () => {};
  const lifecycle = new Promise<void>((resolve) => {
    releaseLifecycle = resolve;
  });
  hostLifecycleTail = predecessor.catch(() => undefined).then(() => lifecycle);
  await predecessor.catch(() => undefined);

  let session: JarvisKernelHostSession;
  try {
    session = await start();
  } catch {
    releaseLifecycle();
    return Object.freeze({ role: 'unavailable', reason: 'host_unavailable' });
  }
  if (session.role === 'unavailable') {
    releaseLifecycle();
    return session;
  }

  let disposePromise: Promise<void> | null = null;
  return Object.freeze({
    role: 'host' as const,
    invalidateAccount: session.invalidateAccount,
    dispose: () => {
      disposePromise ??= session.dispose().finally(releaseLifecycle);
      return disposePromise;
    },
  });
}

export async function startJarvisKernelHost(
  options: StartJarvisKernelHostOptions,
): Promise<JarvisKernelHostSession> {
  if (isTauriRuntime()) return startExclusiveHost(() => startNativeHost(options));
  if (isBrowserAuxiliarySurface()) {
    return Object.freeze({ role: 'unavailable', reason: 'host_unavailable' });
  }
  return startExclusiveHost(() => startBrowserHost(options));
}
