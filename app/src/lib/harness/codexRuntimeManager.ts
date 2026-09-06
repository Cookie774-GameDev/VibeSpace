const EVENT_NAME = 'vibespace://managed-codex-install-state';
const MAX_MESSAGE = 512;

export type CodexRuntimeDetection =
  | { status: 'missing'; reason?: string }
  | { status: 'incomplete'; reason: string }
  | {
      status: 'ready';
      codexVersion: string;
      openCodexVersion: string;
      executableId: string;
    };

export type ManagedCodexRuntimeEvent =
  | { kind: 'installing'; component: 'codex' | 'opencodex'; progress: number }
  | { kind: 'ready'; codexVersion: string; openCodexVersion: string; executableId: string }
  | { kind: 'failed'; recoverable: boolean; message: string };

export type CodexRuntimeState =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'installing'; component: 'codex' | 'opencodex'; progress: number }
  | {
      kind: 'ready';
      codexVersion: string;
      openCodexVersion: string;
      executableId: string;
    }
  | { kind: 'failed'; recoverable: boolean; message: string };

export interface CodexRuntimeNativeAdapter {
  available(): boolean;
  detect(): Promise<CodexRuntimeDetection>;
  install(): Promise<CodexRuntimeDetection>;
  cancel(): Promise<boolean>;
  listen(listener: (event: ManagedCodexRuntimeEvent) => void): Promise<() => void>;
}

export interface CodexRuntimeManager {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CodexRuntimeState;
  refresh(): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
}

function bounded(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : fallback;
  const text = raw.replace(/\s+/g, ' ').trim() || fallback;
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;
}

function mapDetection(value: CodexRuntimeDetection): CodexRuntimeState {
  if (value.status === 'missing') return { kind: 'missing' };
  if (value.status === 'incomplete') {
    return {
      kind: 'incomplete',
      reason: bounded(value.reason, 'Managed Codex tools are incomplete.'),
    };
  }
  if (
    !value.codexVersion.trim() ||
    !value.openCodexVersion.trim() ||
    !/^cli-executable-[A-Za-z0-9_-]+$/u.test(value.executableId)
  ) {
    throw new Error('Managed Codex tools returned an invalid trusted identity.');
  }
  return {
    kind: 'ready',
    codexVersion: value.codexVersion,
    openCodexVersion: value.openCodexVersion,
    executableId: value.executableId,
  };
}

const nativeAdapter: CodexRuntimeNativeAdapter = {
  available: () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  async detect() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<CodexRuntimeDetection>('managed_codex_runtime_detect');
  },
  async install() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<CodexRuntimeDetection>('managed_codex_runtime_install');
  },
  async cancel() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('managed_codex_runtime_install_cancel');
  },
  async listen(listener) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<ManagedCodexRuntimeEvent>(EVENT_NAME, ({ payload }) => listener(payload));
  },
};

export function createCodexRuntimeManager(
  native: CodexRuntimeNativeAdapter = nativeAdapter,
): CodexRuntimeManager {
  let snapshot: CodexRuntimeState = { kind: 'checking' };
  const subscribers = new Set<() => void>();
  let lifecycle = 0;
  let operation = 0;
  let unlisten: (() => void) | undefined;
  let installFlight: Promise<void> | undefined;
  let refreshFlight: { operation: number; promise: Promise<void> } | undefined;

  const publish = (next: CodexRuntimeState) => {
    snapshot = next;
    subscribers.forEach((subscriber) => subscriber());
  };
  const fail = (error: unknown, fallback: string) =>
    publish({ kind: 'failed', recoverable: true, message: bounded(error, fallback) });
  const apply = (detection: CodexRuntimeDetection) => publish(mapDetection(detection));

  const refresh = (): Promise<void> => {
    if (installFlight) return installFlight;
    if (refreshFlight?.operation === operation) return refreshFlight.promise;
    const ticket = ++operation;
    const promise = (async () => {
      if (!native.available()) {
        if (ticket === operation) publish({ kind: 'missing' });
        return;
      }
      if (snapshot.kind !== 'ready') publish({ kind: 'checking' });
      try {
        const detection = await native.detect();
        if (ticket === operation) apply(detection);
      } catch (error) {
        if (ticket === operation) fail(error, 'Managed Codex detection failed.');
      }
    })();
    const flight = { operation: ticket, promise };
    refreshFlight = flight;
    const clear = () => {
      if (refreshFlight === flight) refreshFlight = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  };

  return {
    subscribe(listener) {
      subscribers.add(listener);
      if (subscribers.size === 1) {
        const generation = ++lifecycle;
        void native
          .listen((event) => {
            if (generation !== lifecycle || subscribers.size === 0) return;
            if (event.kind === 'installing') {
              publish({
                kind: 'installing',
                component: event.component,
                progress: Number.isFinite(event.progress)
                  ? Math.min(1, Math.max(0, event.progress))
                  : 0,
              });
            } else if (event.kind === 'ready') {
              apply({ status: 'ready', ...event });
            } else {
              fail(event.message, 'Managed Codex installation failed.');
            }
          })
          .then((stop) => {
            if (generation !== lifecycle || subscribers.size === 0) stop();
            else unlisten = stop;
          })
          .catch(() => {});
        void refresh();
      }
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          lifecycle += 1;
          operation += 1;
          unlisten?.();
          unlisten = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    install() {
      if (installFlight) return installFlight;
      const ticket = ++operation;
      const promise = (async () => {
        if (!native.available()) {
          publish({
            kind: 'failed',
            recoverable: false,
            message: 'Native Codex installation is unavailable.',
          });
          return;
        }
        publish({ kind: 'installing', component: 'codex', progress: 0 });
        try {
          const detection = await native.install();
          if (ticket === operation) apply(detection);
        } catch (error) {
          if (ticket === operation) fail(error, 'Managed Codex installation failed.');
        }
      })();
      installFlight = promise;
      void promise.finally(() => {
        if (installFlight === promise) installFlight = undefined;
      });
      return promise;
    },
    async cancel() {
      if (!native.available()) return;
      try {
        await native.cancel();
      } catch (error) {
        fail(error, 'Managed Codex cancellation failed.');
      }
    },
  };
}

export const codexRuntimeManager = createCodexRuntimeManager();
