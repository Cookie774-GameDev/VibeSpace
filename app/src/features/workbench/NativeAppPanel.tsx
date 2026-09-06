import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/ui';
import { useWorkbenchStore } from './store';
import {
  hideNativeAppSurface,
  nativeAppSelectionForPanel,
  openNativeAppSurface,
  nativeAppSurfaceAction,
  consumeNativeAppLaunch,
  nativeAppLaunchGeneration,
  requestNativeAppLaunch,
  detachNativeAppSurface,
  type NativeAppSurfaceStatus,
  type NativeAppBounds,
  type NativeAppSurfaceOpenInput,
} from './nativeApps';
import type { WorkbenchPanel } from './types';

interface NativeAppPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

type NativeRequest = NativeAppSurfaceOpenInput & { key: string };

function createOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  return 'wa_' + (random ?? String(Date.now()) + '_' + Math.random().toString(36).slice(2));
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause.trim();
  return 'workbench_native_app_open_failed';
}

function readNativeBounds(element: HTMLElement | null): NativeAppBounds | null {
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
    // Native HWNDs sit above the WebView. Hide a covered surface so it cannot
    // paint over a foreground panel's HTML controls or intercept their input.
    const ownPanel = element.closest<HTMLElement>('.workbench-panel');
    if (ownPanel) {
      const z = Number(ownPanel.style.zIndex) || 0;
      for (const other of canvas.querySelectorAll<HTMLElement>('.workbench-panel')) {
        if (other === ownPanel || (Number(other.style.zIndex) || 0) <= z) continue;
        const cover = other.getBoundingClientRect();
        if (
          cover.left < rect.right &&
          cover.right > rect.left &&
          cover.top < rect.bottom &&
          cover.bottom > rect.top
        )
          return null;
      }
    }
  }
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function NativeAppPanel({ panel, onUpdate }: NativeAppPanelProps) {
  const route = useUIStore((state) => state.route);
  const selection = nativeAppSelectionForPanel(panel);
  const name =
    panel.settings.nativeAppName?.trim() || (panel.kind === 'ade' ? 'ChatGPT' : panel.title);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const operationId = React.useRef(createOperationId()).current;
  const onUpdateRef = React.useRef(onUpdate);
  const statusRef = React.useRef(panel.status);
  const desiredRef = React.useRef(false);
  const visibleRef = React.useRef(false);
  const generationRef = React.useRef(0);
  const pendingRef = React.useRef<NativeRequest | null>(null);
  const activeRef = React.useRef<NativeRequest | null>(null);
  const openPromiseRef = React.useRef<Promise<void> | null>(null);
  const hidePromiseRef = React.useRef<Promise<void> | null>(null);
  const lastSettledKeyRef = React.useRef<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [host, setHost] = React.useState<NativeAppSurfaceStatus | null>(null);
  const [acting, setActing] = React.useState(false);
  const [retryGeneration, setRetryGeneration] = React.useState(0);
  onUpdateRef.current = onUpdate;
  statusRef.current = panel.status;

  const setPanelStatus = React.useCallback((status: WorkbenchPanel['status']) => {
    if (statusRef.current === status) return;
    statusRef.current = status;
    onUpdateRef.current({ status });
  }, []);

  const hideSurface = React.useCallback(async () => {
    desiredRef.current = false;
    pendingRef.current = null;
    lastSettledKeyRef.current = null;
    if (hidePromiseRef.current) return hidePromiseRef.current;
    const retirement = ++generationRef.current;
    if (!visibleRef.current && !openPromiseRef.current) return;
    const promise = (async () => {
      await openPromiseRef.current?.catch(() => undefined);
      if (generationRef.current !== retirement || desiredRef.current) return;
      await hideNativeAppSurface(panel.id, operationId);
      visibleRef.current = false;
    })().finally(() => {
      if (hidePromiseRef.current === promise) hidePromiseRef.current = null;
    });
    hidePromiseRef.current = promise;
    return promise;
  }, [operationId, panel.id]);

  const openSurface = React.useCallback(
    async (request: NativeRequest) => {
      desiredRef.current = true;
      await hidePromiseRef.current?.catch(() => undefined);
      if (!desiredRef.current) return;
      const active = activeRef.current;
      if (openPromiseRef.current) {
        if (active?.key === request.key || pendingRef.current?.key === request.key) {
          return openPromiseRef.current;
        }
        pendingRef.current = request;
        generationRef.current += 1;
        return openPromiseRef.current;
      }
      if (lastSettledKeyRef.current === request.key) return;
      pendingRef.current = request;
      const run = async () => {
        while (desiredRef.current && pendingRef.current) {
          const current = pendingRef.current;
          pendingRef.current = null;
          activeRef.current = current;
          const generation = ++generationRef.current;
          setError(null);
          setPanelStatus('busy');
          try {
            const result = await openNativeAppSurface({
              ...current,
              launch: consumeNativeAppLaunch(panel.id),
            });
            if (!desiredRef.current || pendingRef.current || generation !== generationRef.current) {
              continue;
            }
            if (result.panelId !== panel.id || result.operationId !== operationId) {
              throw new Error('workbench_native_app_operation_stale');
            }
            if ((!result.embedded && !result.fallback) || result.error) {
              throw new Error(result.error || 'workbench_native_app_window_unavailable');
            }
            lastSettledKeyRef.current = current.key;
            visibleRef.current = true;
            setHost(result);
            setError(null);
            setPanelStatus('ready');
          } catch (cause) {
            if (!desiredRef.current || pendingRef.current) continue;
            lastSettledKeyRef.current = current.key;
            visibleRef.current = false;
            setError(failureMessage(cause));
            setPanelStatus('error');
          }
        }
      };
      const promise = run().finally(() => {
        if (openPromiseRef.current === promise) {
          openPromiseRef.current = null;
          activeRef.current = null;
        }
      });
      openPromiseRef.current = promise;
      return promise;
    },
    [operationId, panel.id, setPanelStatus],
  );

  const syncSurface = React.useCallback(async () => {
    if (
      route !== 'workbench' ||
      panel.minimized ||
      !selection ||
      document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"]',
      )
    ) {
      await hideSurface();
      return;
    }
    const bounds = readNativeBounds(surfaceRef.current);
    if (!bounds) {
      await hideSurface();
      return;
    }
    const input: NativeAppSurfaceOpenInput = {
      panelId: panel.id,
      operationId,
      appId: selection.appId,
      name,
      ...(selection.path ? { path: selection.path } : {}),
      bounds,
      zIndex: panel.z,
      scaleFactor: window.devicePixelRatio || 1,
    };
    const key = JSON.stringify({
      ...input,
      retryGeneration,
      launchGeneration: nativeAppLaunchGeneration(panel.id),
    });
    await openSurface({ ...input, key });
  }, [
    hideSurface,
    name,
    openSurface,
    operationId,
    panel.id,
    panel.minimized,
    panel.z,
    retryGeneration,
    route,
    selection,
  ]);

  React.useEffect(() => {
    const refresh = () => void syncSurface();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    const overlays = new MutationObserver(refresh);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    refresh();
    return () => {
      observer?.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
    };
  }, [syncSurface]);

  React.useLayoutEffect(() => {
    void syncSurface();
  });

  React.useEffect(() => {
    if (!host || route !== 'workbench' || panel.minimized) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || !visibleRef.current) return;
      pending = true;
      try {
        const value = await nativeAppSurfaceAction(panel.id, operationId, 'status');
        if (!disposed && value && value.panelId === panel.id && value.operationId === operationId) {
          setHost(value);
        }
      } catch (cause) {
        if (!disposed) {
          setError(failureMessage(cause));
          setPanelStatus('error');
        }
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 1500);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [!!host, route, panel.id, panel.minimized, operationId, setPanelStatus]);

  const actOnHost = async () => {
    if (acting) return;
    setActing(true);
    setError(null);
    try {
      if (!host?.running) {
        requestNativeAppLaunch(panel.id);
        setRetryGeneration((value) => value + 1);
        return;
      }
      await nativeAppSurfaceAction(panel.id, operationId, host?.running ? 'focus' : 'launch');
      const value = await nativeAppSurfaceAction(panel.id, operationId, 'status');
      if (value && value.panelId === panel.id && value.operationId === operationId) setHost(value);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setActing(false);
    }
  };

  React.useEffect(
    () => () => {
      desiredRef.current = false;
      pendingRef.current = null;
      void hideSurface()
        .then(async () => {
          // Route changes keep the panel. Removal by templates/context menus must
          // release the native window just like the panel's Close button does.
          if (!useWorkbenchStore.getState().panels.some((entry) => entry.id === panel.id)) {
            await detachNativeAppSurface(panel.id);
          }
        })
        .catch(() => undefined);
    },
    [hideSurface, panel.id],
  );

  if (!selection) {
    return (
      <div className="workbench-panel-empty" role="alert">
        <strong>App unavailable</strong>
        <span>Workbench did not receive a valid application identity.</span>
      </div>
    );
  }

  return (
    <div className="workbench-native-app" data-native-app-id={selection.appId}>
      <div
        ref={surfaceRef}
        className="workbench-native-app-surface"
        data-testid="workbench-native-app-surface"
        role="region"
        aria-label={name + ' desktop app'}
      />
      {host?.fallback ? (
        <div className="workbench-native-app-overlay" role="status">
          <strong>
            {name} · {host.running ? 'Running' : 'Closed'}
          </strong>
          <span>This app opens in a separate window. Embedding is unavailable.</span>
          {host.embeddingError ? <span>{host.embeddingError}</span> : null}
          <span>The app remains under your control when this panel closes.</span>
          {host.running ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetryGeneration((value) => value + 1)}
            >
              Show in Workbench
            </Button>
          ) : null}
          {selection.appId === 'chatgpt' ? (
            <span>
              External app sessions do not receive VibeSpace Context Map tools automatically.
            </span>
          ) : null}
          {error ? <span role="alert">{error}</span> : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={acting}
            aria-label={(host.running ? 'Focus ' : 'Launch ') + name}
            onClick={() => void actOnHost()}
          >
            {acting ? 'Opening…' : (host.running ? 'Focus ' : 'Launch ') + name}
          </Button>
        </div>
      ) : error ? (
        <div className="workbench-native-app-overlay" role="alert">
          <strong>{name} could not open</strong>
          <span>{error}</span>
          <span>Start the app or choose its executable from Apps, then retry.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={'Retry ' + name}
            onClick={() => {
              requestNativeAppLaunch(panel.id);
              setRetryGeneration((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : panel.status !== 'ready' ? (
        <div className="workbench-native-app-overlay" role="status">
          Opening {name}…
        </div>
      ) : null}
    </div>
  );
}

export { readNativeBounds };
