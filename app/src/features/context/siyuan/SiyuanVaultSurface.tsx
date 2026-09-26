import * as React from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui';
import {
  measureSiyuanSurfaceBounds,
  productionSiyuanSurfaceBridge,
  redactSiyuanSurfaceError,
  type SiyuanSurfaceBridge,
} from './siyuanSurface';

let surfaceOperationSequence = 0;

function nextSurfaceOperationId(): string {
  surfaceOperationSequence += 1;
  return `siyuan-open-${Date.now()}-${surfaceOperationSequence}`;
}

export function SiyuanVaultLoading({ stage }: { stage: 'checking' | 'starting' }) {
  return (
    <div
      data-testid="siyuan-vault-loading"
      role="status"
      aria-live="polite"
      className="relative grid h-full min-h-[240px] w-full place-items-center overflow-hidden bg-paper px-6 py-10 text-center"
    >
      <div className="pointer-events-none absolute -top-28 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-accent-copper/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-36 left-1/2 h-72 w-[34rem] -translate-x-1/2 rounded-full bg-accent-sage/10 blur-3xl" />
      <div className="relative flex max-w-sm flex-col items-center">
        <div className="relative mb-7 grid h-44 w-44 place-items-center">
          <div className="absolute inset-1 rounded-full border border-accent-copper/20" />
          <div className="absolute inset-0 rounded-full border border-dashed border-accent-copper/35 motion-safe:animate-spin motion-reduce:animate-none [animation-duration:12s]" />
          <div className="absolute inset-5 rounded-[2rem] border border-accent-copper/20 bg-panel/85 shadow-soft" />
          <svg
            data-siyuan-axo
            viewBox="0 0 160 160"
            className="relative h-32 w-32 drop-shadow-md motion-safe:animate-bounce motion-reduce:animate-none [animation-duration:2.4s]"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M50 63 23 50l11 18-17 7 23 7M110 63l27-13-11 18 17 7-23 7"
              fill="#e49b78"
              stroke="#a75e47"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path
              d="M49 82 21 85l17 9-10 12 26-8M111 82l28 3-17 9 10 12-26-8"
              fill="#d57b61"
              stroke="#a75e47"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path
              d="M61 112c-4 7-7 13-7 19m45-19c4 7 7 13 7 19"
              fill="none"
              stroke="#a75e47"
              strokeWidth="6"
              strokeLinecap="round"
            />
            <path
              d="M47 111c5-18 18-28 33-28s28 10 33 28l-6 23H53z"
              fill="#f9e9d4"
              stroke="#a75e47"
              strokeWidth="3"
            />
            <path
              d="M27 59c0-25 22-43 53-43s53 18 53 43v29c0 26-23 43-53 43S27 114 27 88z"
              fill="#fff3df"
              stroke="#a75e47"
              strokeWidth="3"
            />
            <path
              d="M41 67c2-21 18-34 39-34s37 13 39 34v20c0 21-17 32-39 32S41 108 41 87z"
              fill="#3f302b"
            />
            <path
              d="M65 45c4-5 10-7 15-7s11 2 15 7"
              fill="none"
              stroke="#edb08b"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle cx="63" cy="73" r="4" fill="#fff7e9" />
            <circle cx="97" cy="73" r="4" fill="#fff7e9" />
            <path
              d="M72 91c5 5 11 5 16 0"
              fill="none"
              stroke="#edb08b"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path d="M77 25h6m-3-3v6" stroke="#a75e47" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.28em] text-accent-copper">
          Context Vault
        </p>
        <h2 className="font-display text-2xl font-semibold text-foreground">
          Starting SiYuan Context Map
        </h2>
        <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
          {stage === 'checking'
            ? 'Axo is checking your saved map and picking up the latest safe checkpoint.'
            : 'Axo is opening the local SiYuan graph. Your source files stay where they are.'}
        </p>
        <div className="mt-6 flex items-center gap-1.5" aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-copper motion-safe:animate-pulse motion-reduce:animate-none" />
          <span className="h-1.5 w-1.5 rounded-full bg-accent-copper/70 motion-safe:animate-pulse motion-reduce:animate-none [animation-delay:250ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-accent-copper/40 motion-safe:animate-pulse motion-reduce:animate-none [animation-delay:500ms]" />
        </div>
      </div>
    </div>
  );
}

export function SiyuanVaultSurface({
  projectId,
  mapId,
  notebookId,
  rootDocumentId,
  onClose,
  bridge = productionSiyuanSurfaceBridge,
}: {
  projectId: string;
  mapId: string;
  notebookId: string | null;
  rootDocumentId: string | null;
  onClose(): void;
  bridge?: SiyuanSurfaceBridge;
}) {
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const openGenerationRef = React.useRef(0);
  const operationIdRef = React.useRef<string | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState('');

  const open = React.useCallback(async () => {
    const element = surfaceRef.current;
    if (!element) return;
    const generation = ++openGenerationRef.current;
    const operationId = nextSurfaceOperationId();
    operationIdRef.current = operationId;
    const isCurrent = () => openGenerationRef.current === generation;
    setState('loading');
    setError('');
    try {
      let status = await bridge.open(
        operationId,
        projectId,
        { mapId, notebookId, rootDocumentId, graphMode: 'local' },
        measureSiyuanSurfaceBounds(element),
      );
      if (!isCurrent()) {
        await bridge.close(operationId).catch(() => false);
        return;
      }
      const assertTarget = () => {
        if (
          !status.created ||
          !status.visible ||
          status.projectId !== projectId ||
          status.mapId !== mapId ||
          status.notebookId !== notebookId ||
          status.rootDocumentId !== rootDocumentId ||
          status.graphMode !== 'local' ||
          status.graphState === null
        ) {
          throw new Error('siyuan_surface_status_invalid');
        }
      };
      assertTarget();
      // Allow the native navigation budget plus its bounded graph initialization
      // and a small status-delivery margin. Loading is never treated as ready.
      const deadline = Date.now() + 65_000;
      while (status.graphState === 'loading' && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (!isCurrent()) return;
        status = await bridge.status();
        if (!isCurrent()) return;
        assertTarget();
      }
      if (status.graphState === 'failed') {
        throw new Error(status.graphError ?? 'siyuan_graph_unavailable');
      }
      if (status.graphState !== 'ready') {
        throw new Error('siyuan_graph_target_timeout');
      }
      if (isCurrent()) setState('ready');
    } catch (cause) {
      if (!isCurrent()) return;
      await bridge.close(operationId).catch(() => false);
      if (!isCurrent()) return;
      setError(redactSiyuanSurfaceError(cause));
      setState('error');
    }
  }, [bridge, mapId, notebookId, projectId, rootDocumentId]);

  React.useEffect(() => {
    let cancelled = false;
    const openTimer = window.setTimeout(() => {
      if (!cancelled) void open();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(openTimer);
      openGenerationRef.current += 1;
      const operationId = operationIdRef.current;
      operationIdRef.current = null;
      // A retained child webview keeps the native window in multi-webview
      // mode even while hidden. Commands that legitimately require the
      // ordinary main WebviewWindow would then fail before reaching their
      // authority checks. Retire the child whenever focused-map mode exits;
      // reopening remains fast because the supervised SiYuan kernel stays up.
      if (operationId) {
        void bridge
          .hide(operationId)
          .catch(() => false)
          .then(() => bridge.close(operationId).catch(() => false));
      }
    };
  }, [bridge, open]);

  React.useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    let lastBounds = '';
    let inFlight = false;
    let queued = false;
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      try {
        const operationId = operationIdRef.current;
        if (!operationId) return;
        // Native geometry is serialized. Keep just the latest measurement
        // instead of queuing a command for every intermediate resize.
        if (inFlight) {
          queued = true;
          return;
        }
        const bounds = measureSiyuanSurfaceBounds(element);
        const serialized = `${operationId}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
        if (serialized === lastBounds) return;
        inFlight = true;
        void bridge
          .setBounds(operationId, bounds)
          .then((applied) => {
            if (!disposed && applied && operationIdRef.current === operationId)
              lastBounds = serialized;
          })
          .catch(() => false)
          .finally(() => {
            inFlight = false;
            if (queued) {
              queued = false;
              sync();
            }
          });
      } catch {
        // The open/retry state remains the user-facing authority.
      }
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    sync();
    const moveMonitor = window.setInterval(sync, 250);
    window.addEventListener('resize', sync);
    return () => {
      disposed = true;
      queued = false;
      observer.disconnect();
      window.clearInterval(moveMonitor);
      window.removeEventListener('resize', sync);
    };
  }, [bridge]);

  const close = async () => {
    openGenerationRef.current += 1;
    const operationId = operationIdRef.current;
    operationIdRef.current = null;
    if (operationId) {
      await bridge.hide(operationId).catch(() => false);
      await bridge.close(operationId).catch(() => false);
    }
    onClose();
  };

  return (
    <section
      data-testid="siyuan-vault-surface"
      data-siyuan-map-id={mapId}
      className="absolute inset-0 z-50 flex min-h-0 flex-col bg-background"
      aria-label="SiYuan Context Vault"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-ui-strong text-foreground">
            <ShieldCheck className="h-4 w-4 text-accent-sage" /> Context Vault
          </div>
          <p className="truncate text-metadata text-muted-foreground">
            Official SiYuan v3.8.1 graph · embedded · project-scoped · local loopback only
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void open()}
          disabled={state !== 'ready'}
        >
          <RefreshCw className="h-4 w-4" /> Reload
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void close()}>
          <X className="h-4 w-4" /> Close
        </Button>
      </header>
      <div
        ref={surfaceRef}
        className="relative min-h-[240px] flex-1 overflow-hidden bg-paper"
        data-siyuan-surface-state={state}
      >
        {state === 'loading' ? <SiyuanVaultLoading stage="starting" /> : null}
        {state !== 'loading' ? (
          <div className="absolute inset-0 grid place-items-center p-8 text-center">
            {state === 'error' ? (
              <div role="alert" className="max-w-lg rounded-xl border border-destructive/30 p-5">
                <h2 className="text-ui-strong text-foreground">Context Vault could not open</h2>
                <p className="mt-2 font-mono text-metadata text-destructive">{error}</p>
                <Button className="mt-4" size="sm" variant="accent" onClick={() => void open()}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="text-secondary text-muted-foreground">
                The official SiYuan graph is embedded inside this VibeSpace page.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
