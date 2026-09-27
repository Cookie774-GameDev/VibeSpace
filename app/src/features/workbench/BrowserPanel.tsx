import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  ExternalLink,
  Globe2,
  RefreshCw,
  Square,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { openExternal } from '@/lib/tauri';
import { isTauri } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { browserFramePolicy, normalizeBrowserUrl } from './browserSecurity';
import type { WorkbenchPanel } from './types';

interface BrowserPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface NativeBrowserState {
  panelId: string;
  operationId: string;
  url: string;
  loading: boolean;
  error?: string | null;
}

interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeOpenRequest {
  url: string;
  bounds: SurfaceBounds;
  generation: number;
  preserveNavigation: boolean;
}

function readBounds(element: HTMLElement | null): SurfaceBounds | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const canvas = element.closest<HTMLElement>('.workbench-canvas');
  if (canvas) {
    const canvasRect = canvas.getBoundingClientRect();
    const tolerance = 0.5;
    if (
      rect.left < canvasRect.left - tolerance ||
      rect.top < canvasRect.top - tolerance ||
      rect.right > canvasRect.right + tolerance ||
      rect.bottom > canvasRect.bottom + tolerance
    ) {
      return null;
    }
  }
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function createOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  return `wb_${random ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function sameNativeOpenRequest(left: NativeOpenRequest | null, right: NativeOpenRequest): boolean {
  if (!left) return false;
  return (
    left.generation === right.generation &&
    left.url === right.url &&
    left.bounds.x === right.bounds.x &&
    left.bounds.y === right.bounds.y &&
    left.bounds.width === right.bounds.width &&
    left.bounds.height === right.bounds.height
  );
}

function nativeFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause.trim();
  return fallback;
}

function waitForNativeStatus(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}

export function BrowserPanel({ panel, onUpdate }: BrowserPanelProps) {
  const route = useUIStore((state) => state.route);
  const currentUrl = panel.settings.url ?? 'https://developer.mozilla.org';
  const [draft, setDraft] = React.useState(currentUrl);
  const [frameKey, setFrameKey] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('idle');
  const [history, setHistory] = React.useState<string[]>([currentUrl]);
  const [historyIndex, setHistoryIndex] = React.useState(0);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const [operationId] = React.useState(createOperationId);
  const onUpdateRef = React.useRef(onUpdate);
  const settingsRef = React.useRef(panel.settings);
  const panelStatusRef = React.useRef(panel.status);
  const draftDirtyRef = React.useRef(false);
  const nativeUrlRef = React.useRef(currentUrl);
  const nativeDesiredUrlRef = React.useRef(currentUrl);
  const nativeRequestGenerationRef = React.useRef(0);
  const nativeStatusGenerationRef = React.useRef(0);
  const nativeSurfaceDesiredRef = React.useRef(false);
  const nativeHidePromiseRef = React.useRef<Promise<void> | null>(null);
  const nativeOpenRef = React.useRef<{
    active: NativeOpenRequest | null;
    pending: NativeOpenRequest | null;
    promise: Promise<void> | null;
    lastSettled: NativeOpenRequest | null;
    mayExist: boolean;
  }>({ active: null, pending: null, promise: null, lastSettled: null, mayExist: false });
  onUpdateRef.current = onUpdate;
  settingsRef.current = panel.settings;
  panelStatusRef.current = panel.status;

  const applyNativeState = React.useCallback(
    (payload: NativeBrowserState) => {
      if (payload.panelId !== panel.id || payload.operationId !== operationId) {
        throw new Error('workbench_browser_operation_stale');
      }
      const normalized = normalizeBrowserUrl(payload.url);
      nativeUrlRef.current = normalized;
      nativeDesiredUrlRef.current = normalized;
      if (!draftDirtyRef.current) setDraft(normalized);
      setError(payload.error ?? null);
      setLoadState(payload.error ? 'error' : payload.loading ? 'loading' : 'loaded');
      const nextStatus = payload.error ? 'error' : 'ready';
      if (settingsRef.current.url !== normalized || panelStatusRef.current !== nextStatus) {
        const nextSettings = { ...settingsRef.current, url: normalized };
        settingsRef.current = nextSettings;
        panelStatusRef.current = nextStatus;
        onUpdateRef.current({ settings: nextSettings, status: nextStatus });
      }
    },
    [operationId, panel.id],
  );

  const reconcileNativeState = React.useCallback(
    async (requestGeneration: number) => {
      const statusGeneration = ++nativeStatusGenerationRef.current;
      let delayMs = 200;
      while (
        nativeStatusGenerationRef.current === statusGeneration &&
        nativeRequestGenerationRef.current === requestGeneration
      ) {
        const payload = await invoke<NativeBrowserState>('workbench_browser_surface_status', {
          panelId: panel.id,
          operationId,
        });
        if (
          nativeStatusGenerationRef.current !== statusGeneration ||
          nativeRequestGenerationRef.current !== requestGeneration
        )
          return;
        applyNativeState(payload);
        if (!payload.loading || payload.error) return;
        await waitForNativeStatus(delayMs);
        delayMs = Math.min(delayMs * 2, 1_000);
      }
    },
    [applyNativeState, operationId, panel.id],
  );

  const policy = React.useMemo(() => {
    try {
      return browserFramePolicy(currentUrl, undefined, isTauri);
    } catch {
      return null;
    }
  }, [currentUrl]);

  const nativeSurfaceAllowed =
    route === 'workbench' && !panel.minimized && policy?.delivery === 'native-child';

  const retireNativeSurface = React.useCallback(async () => {
    nativeSurfaceDesiredRef.current = false;
    nativeStatusGenerationRef.current += 1;
    const state = nativeOpenRef.current;
    state.pending = null;
    state.lastSettled = null;
    if (nativeHidePromiseRef.current) return nativeHidePromiseRef.current;
    if (!state.mayExist && !state.promise) return;

    const retirementGeneration = ++nativeRequestGenerationRef.current;
    const promise = (async () => {
      await state.promise?.catch(() => undefined);
      if (
        nativeRequestGenerationRef.current !== retirementGeneration ||
        nativeSurfaceDesiredRef.current
      ) {
        return;
      }
      await invoke('workbench_browser_surface_hide', { panelId: panel.id, operationId });
      state.mayExist = false;
    })().finally(() => {
      if (nativeHidePromiseRef.current === promise) nativeHidePromiseRef.current = null;
    });
    nativeHidePromiseRef.current = promise;
    return promise;
  }, [operationId, panel.id]);

  const openNative = React.useCallback(
    async (url: string, bounds: SurfaceBounds, preserveNavigation: boolean) => {
      if (!isTauri) throw new Error('The in-window browser is available in the VibeSpace app.');
      await nativeHidePromiseRef.current?.catch(() => undefined);
      if (!nativeSurfaceDesiredRef.current) return;
      const state = nativeOpenRef.current;
      const requested = {
        url,
        bounds,
        generation: nativeRequestGenerationRef.current,
        preserveNavigation,
      };
      if (
        preserveNavigation &&
        !state.promise &&
        sameNativeOpenRequest(state.lastSettled, requested)
      )
        return;
      if (!preserveNavigation || !state.mayExist) setLoadState('loading');
      if (state.promise) {
        const queued = state.pending ?? state.active;
        if (
          sameNativeOpenRequest(queued, requested) &&
          (preserveNavigation || queued?.preserveNavigation === false)
        )
          return state.promise;
        state.pending = {
          url,
          bounds,
          generation: ++nativeRequestGenerationRef.current,
          preserveNavigation:
            preserveNavigation &&
            !(state.pending?.url === url && !state.pending.preserveNavigation),
        };
        nativeStatusGenerationRef.current += 1;
        return state.promise;
      }
      const next = {
        url,
        bounds,
        generation: ++nativeRequestGenerationRef.current,
        preserveNavigation: preserveNavigation && state.mayExist,
      };
      const run = async () => {
        let request: NativeOpenRequest | null = next;
        while (request) {
          state.active = request;
          state.pending = null;
          state.lastSettled = request;
          state.mayExist = true;
          const opened = await invoke<NativeBrowserState>('workbench_browser_surface_open', {
            panelId: panel.id,
            operationId,
            url: request.url,
            bounds: request.bounds,
            preserveNavigation: request.preserveNavigation,
          });
          if (state.pending || nativeRequestGenerationRef.current !== request.generation) {
            request = state.pending;
            continue;
          }
          state.lastSettled = { ...request, url: normalizeBrowserUrl(opened.url) };
          applyNativeState(opened);
          if (opened.loading && !opened.error) {
            const generation = request.generation;
            void reconcileNativeState(generation).catch((cause) => {
              if (
                nativeStatusGenerationRef.current === 0 ||
                nativeRequestGenerationRef.current !== generation
              )
                return;
              setError(nativeFailureMessage(cause, 'Browser state is unavailable.'));
              setLoadState('error');
            });
          }
          request = state.pending;
        }
      };
      const promise = run().finally(() => {
        if (state.promise === promise) {
          state.active = null;
          state.pending = null;
          state.promise = null;
        }
      });
      state.promise = promise;
      return promise;
    },
    [applyNativeState, operationId, panel.id, reconcileNativeState],
  );

  const syncNativeSurface = React.useCallback(
    async (url = nativeDesiredUrlRef.current, preserveNavigation = true) => {
      if (!nativeSurfaceAllowed) {
        await retireNativeSurface();
        return;
      }
      const bounds = readBounds(surfaceRef.current);
      if (!bounds) {
        await retireNativeSurface();
        return;
      }
      nativeSurfaceDesiredRef.current = true;
      await openNative(url, bounds, preserveNavigation);
    },
    [nativeSurfaceAllowed, openNative, retireNativeSurface],
  );

  React.useEffect(() => {
    if (!draftDirtyRef.current) setDraft(currentUrl);
  }, [currentUrl]);

  React.useEffect(() => {
    if (policy?.delivery !== 'native-child') return;
    let disposed = false;

    const refreshBounds = () =>
      void syncNativeSurface().catch((cause) => {
        if (disposed) return;
        setError(nativeFailureMessage(cause, 'The page could not open.'));
        setLoadState('error');
      });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refreshBounds);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    window.addEventListener('resize', refreshBounds);
    window.addEventListener('scroll', refreshBounds, true);
    refreshBounds();

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', refreshBounds);
      window.removeEventListener('scroll', refreshBounds, true);
    };
  }, [policy?.delivery, syncNativeSurface]);

  // The child WebView is native, so CSS transforms and deferred route teardown
  // cannot move or clip it. Reconcile after every React layout commit instead.
  React.useLayoutEffect(() => {
    void syncNativeSurface().catch((cause) => {
      if (!nativeSurfaceDesiredRef.current) return;
      setError(nativeFailureMessage(cause, 'The page could not open.'));
      setLoadState('error');
    });
  });

  React.useEffect(() => {
    if (policy?.delivery !== 'native-child') return;
    if (nativeOpenRef.current.mayExist && nativeUrlRef.current === policy.externalUrl) return;
    nativeUrlRef.current = policy.externalUrl;
    nativeDesiredUrlRef.current = policy.externalUrl;
    void syncNativeSurface(policy.externalUrl, false).catch((cause) => {
      if (!nativeSurfaceDesiredRef.current) return;
      const message = nativeFailureMessage(cause, 'The page could not open.');
      setError(message);
      setLoadState('error');
    });
  }, [policy?.delivery, policy?.externalUrl, syncNativeSurface]);

  React.useEffect(
    () => () => {
      nativeStatusGenerationRef.current = 0;
      nativeSurfaceDesiredRef.current = false;
      void retireNativeSurface().catch(() => undefined);
    },
    [retireNativeSurface],
  );

  React.useEffect(() => {
    if (policy?.delivery === 'embedded') setLoadState('loading');
    else if (policy?.delivery === 'external') setLoadState('idle');
  }, [frameKey, policy]);

  const commitUrl = (normalized: string, pushHistory: boolean) => {
    const nextPolicy = browserFramePolicy(normalized, undefined, isTauri);
    nativeDesiredUrlRef.current = normalized;
    draftDirtyRef.current = false;
    setError(null);
    setDraft(normalized);
    onUpdate({ settings: { ...panel.settings, url: normalized }, status: 'ready' });
    if (pushHistory) {
      setHistory((previous) => {
        const base = previous.slice(0, historyIndex + 1);
        if (base[base.length - 1] === normalized) return base;
        return [...base, normalized].slice(-40);
      });
      setHistoryIndex((index) => Math.min(index + 1, 39));
    }
    setLoadState(nextPolicy.delivery === 'external' ? 'idle' : 'loading');
    if (nextPolicy.delivery === 'embedded') setFrameKey((value) => value + 1);
    else if (nextPolicy.delivery === 'external') {
      void openExternal(nextPolicy.externalUrl).catch((cause) => {
        setError(nativeFailureMessage(cause, 'The page could not open externally.'));
      });
    } else
      void syncNativeSurface(nextPolicy.externalUrl, false).catch((cause) => {
        const message = nativeFailureMessage(cause, 'The page could not open.');
        setError(message);
        setLoadState('error');
        toast.warning('Page could not open', message);
      });
  };

  const navigate = (event?: React.FormEvent) => {
    event?.preventDefault();
    try {
      commitUrl(normalizeBrowserUrl(draft), true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That address cannot be opened.';
      setError(message);
      setLoadState('error');
      toast.warning('Browser address blocked', message);
    }
  };

  const openDraftExternally = () => {
    try {
      const normalized = normalizeBrowserUrl(draft);
      void openExternal(normalized).catch((cause) => {
        const message = nativeFailureMessage(cause, 'The page could not open externally.');
        setError(message);
        toast.warning('External browser could not open', message);
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'That address cannot be opened.';
      setError(message);
      toast.warning('Browser address blocked', message);
    }
  };

  const goHistory = (delta: -1 | 1) => {
    if (policy?.delivery === 'native-child') {
      setError(null);
      setLoadState('loading');
      void invoke('workbench_browser_surface_history', {
        panelId: panel.id,
        operationId,
        delta,
      })
        .then(() => reconcileNativeState(nativeRequestGenerationRef.current))
        .catch((cause) => {
          setError(nativeFailureMessage(cause, 'History is unavailable.'));
          setLoadState('error');
        });
      return;
    }
    const next = historyIndex + delta;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    commitUrl(history[next]!, false);
  };

  const nativeControl = (command: 'reload' | 'stop') => {
    if (policy?.delivery === 'external') {
      if (command === 'reload') openDraftExternally();
      return;
    }
    if (policy?.delivery !== 'native-child') {
      if (command === 'reload') {
        setLoadState('loading');
        setFrameKey((value) => value + 1);
      } else setLoadState('idle');
      return;
    }
    if (command === 'reload') setLoadState('loading');
    void invoke(`workbench_browser_surface_${command}`, {
      panelId: panel.id,
      operationId,
    })
      .then(() => reconcileNativeState(nativeRequestGenerationRef.current))
      .catch((cause) => {
        setError(nativeFailureMessage(cause, `Browser ${command} failed.`));
        setLoadState('error');
      });
  };

  const showFrame = policy?.delivery === 'embedded' && loadState !== 'idle' && !error;
  return (
    <div
      className="workbench-browser"
      data-testid="workbench-browser-panel"
      onWheel={(event) => event.stopPropagation()}
    >
      <form className="workbench-browser-bar" onSubmit={navigate}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          onClick={() => goHistory(-1)}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          onClick={() => goHistory(1)}
        >
          <ArrowRight />
        </Button>
        <Globe2 aria-hidden="true" />
        <input
          className="[html[data-theme=warm]_&]:border-border-mid [html[data-theme=warm]_&]:bg-background [html[data-theme=warm]_&]:text-foreground [html[data-theme=warm]_&]:caret-foreground [html[data-theme=warm]_&]:placeholder:text-muted-foreground"
          aria-label="Browser address"
          value={draft}
          onChange={(event) => {
            draftDirtyRef.current = event.target.value !== currentUrl;
            setDraft(event.target.value);
          }}
          spellCheck={false}
        />
        <Button type="submit" size="icon-sm" variant="ghost" aria-label="Go">
          <CornerDownLeft />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Open in external browser"
          onClick={openDraftExternally}
        >
          <ExternalLink />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reload browser"
          onClick={() => nativeControl('reload')}
        >
          <RefreshCw />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Stop loading"
          onClick={() => nativeControl('stop')}
        >
          <Square />
        </Button>
      </form>
      {loadState === 'loading' ? (
        <p className="workbench-browser-status" aria-live="polite">
          Loading…
        </p>
      ) : null}
      {error ? (
        <div className="workbench-panel-empty" role="alert">
          <strong>Page could not open</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {policy?.delivery === 'native-child' ? (
        <div
          ref={surfaceRef}
          className="workbench-browser-native-surface"
          data-testid="workbench-browser-native-surface"
          aria-label="In-window web page"
        />
      ) : null}
      {policy?.delivery === 'external' ? (
        <div className="workbench-panel-empty">
          <strong>Open this website in a browser tab</strong>
          <span>
            {policy.frameBlocked
              ? 'This website cannot reliably run inside a Workbench iframe.'
              : 'This website needs a browser tab in web mode.'}{' '}
            Your address stays here. Return to this Workbench tab when done.
          </span>
          <span>{policy.externalUrl}</span>
          <Button type="button" onClick={openDraftExternally}>
            Open in browser tab
          </Button>
        </div>
      ) : null}
      {showFrame && policy ? (
        <iframe
          key={`${policy.src}-${frameKey}`}
          title={`${panel.title} web page`}
          src={policy.src}
          sandbox={policy.sandbox}
          referrerPolicy={policy.referrerPolicy}
          allow={policy.allow}
          onLoad={() => setLoadState('loaded')}
          onError={() => {
            setError('This page could not load inside Workbench. Open it in a browser tab.');
            setLoadState('error');
          }}
        />
      ) : null}
      {policy?.delivery === 'embedded' && error ? (
        <Button type="button" onClick={openDraftExternally}>
          Open in browser tab
        </Button>
      ) : null}
      <p className="workbench-browser-engine">
        {isTauri
          ? 'Remote pages stay inside a capability-free VibeSpace child WebView.'
          : policy?.usedEmbed
            ? 'YouTube video player. Open in external browser for the full website.'
            : 'Web mode: local previews stay in Workbench; full websites open in a browser tab.'}
      </p>
    </div>
  );
}

export { readBounds };
