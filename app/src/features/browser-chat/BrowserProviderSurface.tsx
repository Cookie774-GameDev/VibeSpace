import * as React from 'react';
import { ShieldCheck } from 'lucide-react';

import { useUIStore } from '@/stores/ui';
import { resolveChatEngine, useBrowserChatStore } from './browserChatStore';
import type { BrowserChatProviderDefinition } from './providerRegistry';
import {
  browserChatSurface,
  type ProviderSurfaceController,
  type ProviderSurfaceBounds,
  type ProviderSurfaceNavigation,
} from './providerSurface';
import type { BrowserChatAccountProfileKey } from './providerProfileScope';

interface BrowserProviderSurfaceProps {
  readonly provider: BrowserChatProviderDefinition;
  readonly accountProfileKey: BrowserChatAccountProfileKey;
  readonly navigationUrl?: string;
  readonly runtime?: ProviderSurfaceController;
  readonly onNavigation?: (navigation: ProviderSurfaceNavigation) => void;
  readonly fullPage?: boolean;
}

const GEOMETRY_EPSILON = 0.5;
const TRANSITION_FOLLOW_MS = 500;
const BLOCKING_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function boundsEqual(left: ProviderSurfaceBounds | null, right: ProviderSurfaceBounds): boolean {
  return Boolean(
    left &&
    Math.abs(left.x - right.x) <= GEOMETRY_EPSILON &&
    Math.abs(left.y - right.y) <= GEOMETRY_EPSILON &&
    Math.abs(left.width - right.width) <= GEOMETRY_EPSILON &&
    Math.abs(left.height - right.height) <= GEOMETRY_EPSILON,
  );
}

function geometryAncestors(host: HTMLElement): Element[] {
  const result: Element[] = [host];
  let current = host.parentElement;
  while (current && result.length < 16) {
    result.push(current);
    current = current.parentElement;
  }
  return result;
}

function hasOverlappingOverlay(host: HTMLElement, bounds: DOMRect): boolean {
  return [...document.querySelectorAll<HTMLElement>(BLOCKING_OVERLAY_SELECTOR)].some((overlay) => {
    if (host.contains(overlay) || overlay.getAttribute('aria-hidden') === 'true') return false;
    const rect = overlay.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < bounds.right &&
      rect.right > bounds.left &&
      rect.top < bounds.bottom &&
      rect.bottom > bounds.top
    );
  });
}

export function BrowserProviderSurface({
  provider,
  accountProfileKey,
  navigationUrl,
  runtime = browserChatSurface,
  onNavigation,
  fullPage = false,
}: BrowserProviderSurfaceProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const hiddenRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [embeddedUrl, setEmbeddedUrl] = React.useState<string | null>(null);
  const route = useUIStore((state) => state.route);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const engine = useBrowserChatStore((state) => resolveChatEngine(state, activeChatId));
  const surfaceVisible = Boolean(activeChatId) && route === 'chat' && engine === 'browser';
  const setProviderRuntime = useBrowserChatStore((state) => state.setProviderRuntime);
  const onNavigationRef = React.useRef(onNavigation);
  const loadSubscriptionReadyRef = React.useRef<Promise<void>>(Promise.resolve());
  const navigationSubscriptionReadyRef = React.useRef<Promise<void>>(Promise.resolve());
  onNavigationRef.current = onNavigation;

  const requestHide = React.useCallback(
    async (force = false) => {
      if (hiddenRef.current && !force) return;
      hiddenRef.current = true;
      await runtime.hideAll().catch(() => undefined);
    },
    [runtime],
  );

  React.useLayoutEffect(() => {
    if (!runtime.subscribeNavigation) {
      navigationSubscriptionReadyRef.current = Promise.resolve();
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    navigationSubscriptionReadyRef.current = runtime
      .subscribeNavigation((navigation) => {
        if (
          disposed ||
          navigation.providerId !== provider.id ||
          navigation.accountProfileKey !== accountProfileKey ||
          navigation.pageId !== activeChatId
        ) {
          return;
        }
        onNavigationRef.current?.(navigation);
      })
      .then((nextUnsubscribe) => {
        if (disposed) nextUnsubscribe();
        else unsubscribe = nextUnsubscribe;
      });
    void navigationSubscriptionReadyRef.current.catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [accountProfileKey, activeChatId, provider.id, runtime]);

  React.useLayoutEffect(() => {
    if (!runtime.subscribeLoad) {
      loadSubscriptionReadyRef.current = Promise.resolve();
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    loadSubscriptionReadyRef.current = runtime
      .subscribeLoad((load) => {
        if (
          disposed ||
          load.providerId !== provider.id ||
          load.accountProfileKey !== accountProfileKey ||
          load.pageId !== activeChatId
        ) {
          return;
        }
        setProviderRuntime(provider.id, {
          pageStatus: load.phase === 'finished' ? 'ready' : 'opening',
          toolBridgeStatus: provider.toolBridgeStatus,
        });
      })
      .then((nextUnsubscribe) => {
        if (disposed) nextUnsubscribe();
        else unsubscribe = nextUnsubscribe;
      });
    void loadSubscriptionReadyRef.current.catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    accountProfileKey,
    activeChatId,
    provider.id,
    provider.toolBridgeStatus,
    runtime,
    setProviderRuntime,
  ]);

  React.useLayoutEffect(() => {
    if (!surfaceVisible) {
      void requestHide();
      return;
    }

    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let syncFrame = 0;
    let transitionFrame = 0;
    let transitionUntil = 0;
    let unsubscribeHostGeometry: (() => void) | undefined;
    let updateInFlight = false;
    let queuedBounds: ProviderSurfaceBounds | null = null;
    let lastBounds: ProviderSurfaceBounds | null = null;
    let hostVisible = false;
    let hiddenApplied = false;
    let forceNextSync = false;

    const hideManagedSurface = (force = false) => {
      hostVisible = false;
      queuedBounds = null;
      lastBounds = null;
      if (hiddenApplied && !force) return;
      hiddenApplied = true;
      void requestHide(force);
    };

    const openLatestBounds = async (initialBounds: ProviderSurfaceBounds) => {
      if (updateInFlight) {
        queuedBounds = initialBounds;
        return;
      }

      updateInFlight = true;
      let nextBounds: ProviderSurfaceBounds | null = initialBounds;
      try {
        while (nextBounds && !disposed && hostVisible) {
          const bounds = nextBounds;
          queuedBounds = null;
          try {
            await Promise.all([
              loadSubscriptionReadyRef.current,
              navigationSubscriptionReadyRef.current,
            ]);
            if (disposed || !hostVisible) break;
            const result = await runtime.openManaged(
              provider,
              bounds,
              navigationUrl,
              accountProfileKey,
              activeChatId ?? undefined,
            );
            if (disposed || !hostVisible) {
              break;
            }
            setError(null);
            setEmbeddedUrl(result.kind === 'embedded_frame' ? result.url : null);
            setProviderRuntime(provider.id, {
              pageStatus: result.kind === 'managed' && result.loaded ? 'ready' : 'opening',
              toolBridgeStatus: provider.toolBridgeStatus,
            });
          } catch (cause) {
            if (!disposed && hostVisible) {
              const message =
                cause instanceof Error ? cause.message : 'Managed provider surface failed.';
              setError(message);
              setEmbeddedUrl(null);
              setProviderRuntime(provider.id, {
                pageStatus: 'error',
                toolBridgeStatus: provider.toolBridgeStatus,
                error: message,
              });
            }
          }
          nextBounds = queuedBounds;
        }
      } finally {
        updateInFlight = false;
      }
    };

    const synchronizeNow = (force = false) => {
      if (disposed || !surfaceVisible) {
        hideManagedSurface(true);
        return;
      }

      const rect = host.getBoundingClientRect();
      const rendered =
        document.visibilityState !== 'hidden' &&
        host.isConnected &&
        rect.width >= 1 &&
        rect.height >= 1;

      // Child WebViews paint above the main WebView regardless of CSS z-index.
      // Park the provider while a VibeSpace menu or dialog overlaps its area.
      if (!rendered || hasOverlappingOverlay(host, rect)) {
        hideManagedSurface();
        return;
      }

      hostVisible = true;
      hiddenApplied = false;
      hiddenRef.current = false;
      const bounds: ProviderSurfaceBounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };

      if (!force && boundsEqual(lastBounds, bounds)) return;

      const firstOpen = lastBounds === null;
      lastBounds = bounds;
      if (firstOpen) {
        setProviderRuntime(provider.id, {
          pageStatus: 'opening',
          toolBridgeStatus: provider.toolBridgeStatus,
        });
      }
      void openLatestBounds(bounds);
    };

    const scheduleSynchronize = (force = false) => {
      forceNextSync ||= force;
      if (syncFrame) return;
      syncFrame = window.requestAnimationFrame(() => {
        syncFrame = 0;
        const shouldForce = forceNextSync;
        forceNextSync = false;
        synchronizeNow(shouldForce);
      });
    };

    const followActiveTransition = () => {
      transitionFrame = 0;
      if (disposed) return;
      synchronizeNow();
      if (performance.now() < transitionUntil) {
        transitionFrame = window.requestAnimationFrame(followActiveTransition);
      }
    };

    const startTransitionFollow = () => {
      transitionUntil = Math.max(transitionUntil, performance.now() + TRANSITION_FOLLOW_MS);
      if (!transitionFrame) {
        transitionFrame = window.requestAnimationFrame(followActiveTransition);
      }
    };

    const handleVisibilityChange = () => scheduleSynchronize(true);
    const handleGeometryEvent = () => scheduleSynchronize();
    const handleTransitionStart = () => startTransitionFollow();

    synchronizeNow(true);

    const observedElements = geometryAncestors(host);
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => scheduleSynchronize());
    for (const element of observedElements) resizeObserver?.observe(element);

    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => scheduleSynchronize());
    mutationObserver?.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-state', 'aria-hidden'],
    });

    // NavPane width is animated by Motion. Its position can change without a
    // ResizeObserver notification for this host, so follow the shell transition.
    const unsubscribeShellGeometry = useUIStore.subscribe((next, previous) => {
      if (next.navOpen !== previous.navOpen || next.inspectorOpen !== previous.inspectorOpen) {
        startTransitionFollow();
      }
    });

    window.addEventListener('resize', handleGeometryEvent);
    document.addEventListener('scroll', handleGeometryEvent, true);
    document.addEventListener('transitionrun', handleTransitionStart, true);
    document.addEventListener('transitionend', handleGeometryEvent, true);
    document.addEventListener('animationstart', handleTransitionStart, true);
    document.addEventListener('animationend', handleGeometryEvent, true);
    document.addEventListener('fullscreenchange', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    void runtime
      .subscribeHostGeometry?.(() => scheduleSynchronize(true))
      .then((unsubscribe) => {
        if (disposed) {
          unsubscribe();
        } else {
          unsubscribeHostGeometry = unsubscribe;
        }
      });

    return () => {
      disposed = true;
      hostVisible = false;
      queuedBounds = null;
      window.cancelAnimationFrame(syncFrame);
      window.cancelAnimationFrame(transitionFrame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      unsubscribeShellGeometry();
      window.removeEventListener('resize', handleGeometryEvent);
      document.removeEventListener('scroll', handleGeometryEvent, true);
      document.removeEventListener('transitionrun', handleTransitionStart, true);
      document.removeEventListener('transitionend', handleGeometryEvent, true);
      document.removeEventListener('animationstart', handleTransitionStart, true);
      document.removeEventListener('animationend', handleGeometryEvent, true);
      document.removeEventListener('fullscreenchange', handleVisibilityChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeHostGeometry?.();
      void requestHide();
    };
  }, [
    accountProfileKey,
    activeChatId,
    navigationUrl,
    provider,
    requestHide,
    runtime,
    setProviderRuntime,
    surfaceVisible,
  ]);

  return (
    <div
      ref={hostRef}
      aria-label={`${provider.label} provider surface`}
      className={
        fullPage
          ? 'relative min-h-0 flex-1 overflow-hidden bg-background'
          : 'relative min-h-[22rem] flex-1 overflow-hidden rounded-xl border border-border/80 bg-background'
      }
    >
      {surfaceVisible && embeddedUrl && !error ? (
        <iframe
          key={`${provider.id}:${accountProfileKey}:${activeChatId}`}
          title={provider.label}
          src={embeddedUrl}
          className="absolute inset-0 h-full w-full border-0"
          referrerPolicy="no-referrer"
          sandbox="allow-forms allow-same-origin allow-scripts"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8 text-center">
          <div className="max-w-md space-y-3">
            <ShieldCheck className="mx-auto h-8 w-8 text-accent-copper" aria-hidden />
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {error ? 'Provider surface is unavailable' : `Opening ${provider.label}`}
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {error
                  ? `${error} The provider page could not be opened inside VibeSpace.`
                  : 'The provider owns this page and sign-in. VibeSpace does not read passwords, cookies, prompts, or replies.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
