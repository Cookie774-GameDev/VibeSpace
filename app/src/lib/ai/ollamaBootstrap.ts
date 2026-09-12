/**
 * App-wide Ollama bootstrap — auto-start (desktop), discover models, sync catalog.
 *
 * Used on launch, window focus, settings refresh, and model picker open so local
 * models connect without visiting Settings → Local Models first.
 */
import { useAuthStore } from '@/stores/auth';
import { isTauri } from '@/lib/utils';
import { getDiscoveredOllamaModels, syncDiscoveredOllamaModels } from './models';
import {
  ensureOllamaReadySilent,
  invalidateOllamaReadyCache,
  isOllamaReachable,
  listOllamaModelInfo,
  normalizeStoredOllamaEndpoint,
  type OllamaEnsureStatus,
} from './providers/ollama';
import { refreshOpenCodeLocalModelRuntime } from '@/lib/harness/localModelRuntimeRefresh';

export interface OllamaBootstrapResult {
  ready: boolean;
  status: OllamaEnsureStatus;
  modelCount: number;
}

export interface OllamaBootstrapOptions {
  /** Bypass the recent-ready cache; an active bootstrap remains shared. */
  force?: boolean;
  /** Shorter wait when probing on web dev builds. */
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

interface OllamaBootstrapFlight {
  promise: Promise<OllamaBootstrapResult>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

let inFlightBootstrap: OllamaBootstrapFlight | null = null;
let lastReadyAt = 0;
const READY_RECENT_MS = 8_000;

function abortError(): DOMException {
  return new DOMException('Ollama bootstrap cancelled.', 'AbortError');
}

function subscribeToBootstrap(
  flight: OllamaBootstrapFlight,
  signal?: AbortSignal,
): Promise<OllamaBootstrapResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  flight.subscribers += 1;

  return new Promise<OllamaBootstrapResult>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight.subscribers = Math.max(0, flight.subscribers - 1);
      if (flight.subscribers === 0 && !flight.settled) flight.controller.abort();
    };
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      release();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (result) => {
        if (released) return;
        signal?.removeEventListener('abort', onAbort);
        release();
        resolve(result);
      },
      (error) => {
        if (released) return;
        signal?.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

function modelNamesMatch(installed: string, preferred: string): boolean {
  const a = installed.trim().toLowerCase();
  const b = preferred.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

function reconcileDefaultLocalModel(modelNames: string[]): void {
  if (modelNames.length === 0) return;
  const auth = useAuthStore.getState();
  const current = auth.defaultLocalModel.trim();
  if (current && modelNames.some((name) => modelNamesMatch(name, current))) {
    return;
  }
  auth.setDefaultLocalModel(modelNames[0]!);
}

/** Fix persisted Ollama endpoint if the user saved an API key into the URL field. */
export function sanitizeOllamaEndpointFromStore(): void {
  const auth = useAuthStore.getState();
  const raw = auth.apiKeys.ollama ?? '';
  const normalized = normalizeStoredOllamaEndpoint(raw);
  if (raw.trim() && raw.trim() !== normalized) {
    auth.setApiKey('ollama', normalized);
  }
}

export function invalidateOllamaBootstrap(): void {
  inFlightBootstrap?.controller.abort();
  inFlightBootstrap = null;
  lastReadyAt = 0;
  invalidateOllamaReadyCache();
}

function defaultWaitTimeoutMs(): number {
  return isTauri ? 90_000 : 30_000;
}

async function runBootstrap(options: OllamaBootstrapOptions = {}): Promise<OllamaBootstrapResult> {
  sanitizeOllamaEndpointFromStore();

  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs();
  let status: OllamaEnsureStatus;
  const initiallyReachable = await isOllamaReachable(options.signal);

  if (initiallyReachable) {
    status = {
      ready: true,
      apiReachable: true,
      installed: true,
      phase: 'ready',
      detail: 'Ollama API is reachable.',
      statusMsg: 'Ollama ready',
    };
  } else {
    status = await ensureOllamaReadySilent(options.signal, undefined, { waitTimeoutMs });
  }

  if (!status.ready) {
    // Keep the last verified catalog. A brief probe failure must not wipe
    // discovered models and block chat sends while Ollama is still connected.
    return {
      ready: false,
      status,
      modelCount: getDiscoveredOllamaModels().length,
    };
  }

  let models = await listOllamaModelInfo(options.signal);
  if (models.length === 0 && !options.signal?.aborted) {
    status = await ensureOllamaReadySilent(options.signal, undefined, { waitTimeoutMs });
    if (status.ready) {
      models = await listOllamaModelInfo(options.signal);
    }
  }

  const names = models.map((model) => model.name);
  const previousNames = getDiscoveredOllamaModels();
  const modelSetChanged =
    names.length !== previousNames.length ||
    names.some((name, index) => name !== previousNames[index]);
  syncDiscoveredOllamaModels(names);
  reconcileDefaultLocalModel(names);
  if (names.length > 0 && modelSetChanged) {
    await refreshOpenCodeLocalModelRuntime();
  }

  if (names.length > 0) {
    lastReadyAt = Date.now();
  }

  return {
    ready: status.ready,
    status,
    modelCount: names.length,
  };
}

/**
 * Ensure Ollama is up (auto-start on desktop), then sync installed models into
 * the chat catalog. Failed attempts are never cached — only in-flight work is deduped.
 */
export async function bootstrapOllamaConnection(
  options: OllamaBootstrapOptions = {},
): Promise<OllamaBootstrapResult> {
  if (options.signal?.aborted) throw abortError();

  if (
    !options.force &&
    !inFlightBootstrap &&
    lastReadyAt > 0 &&
    Date.now() - lastReadyAt < READY_RECENT_MS
  ) {
    let names: Awaited<ReturnType<typeof listOllamaModelInfo>>;
    try {
      names = await listOllamaModelInfo(options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
        throw (error as Error)?.name === 'AbortError' ? error : abortError();
      }
      names = [];
    }
    if (options.signal?.aborted) throw abortError();
    if (names.length > 0) {
      return {
        ready: true,
        status: {
          ready: true,
          apiReachable: true,
          installed: true,
          phase: 'ready',
          detail: 'Ollama API is reachable.',
          statusMsg: 'Ollama ready',
        },
        modelCount: names.length,
      };
    }
  }

  if (options.force) {
    lastReadyAt = 0;
    invalidateOllamaReadyCache();
  }

  if (inFlightBootstrap) {
    return subscribeToBootstrap(inFlightBootstrap, options.signal);
  }

  const controller = new AbortController();
  let flight!: OllamaBootstrapFlight;
  const promise = runBootstrap({ ...options, signal: controller.signal }).finally(() => {
    flight.settled = true;
    if (inFlightBootstrap === flight) inFlightBootstrap = null;
  });
  flight = {
    controller,
    subscribers: 0,
    settled: false,
    promise,
  };
  inFlightBootstrap = flight;

  return subscribeToBootstrap(flight, options.signal);
}
