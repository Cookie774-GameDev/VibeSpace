export const CONTEXT_NAVIGATION_EVENT = 'jarvis:context:navigate';

export type ContextNavigationIntent =
  Readonly<{ target: 'overview' }> | Readonly<{ target: 'map'; mapId: string }>;

let pendingNavigation: ContextNavigationIntent | null = null;
const subscriptions = new Set<(event: Event) => void>();

export function requestContextNavigation(intent: ContextNavigationIntent): void {
  window.setTimeout(() => {
    if (subscriptions.size === 0) pendingNavigation = intent;
    window.dispatchEvent(
      new CustomEvent<ContextNavigationIntent>(CONTEXT_NAVIGATION_EVENT, {
        detail: intent,
      }),
    );
  }, 0);
}

export function subscribeContextNavigation(
  listener: (intent: ContextNavigationIntent) => void,
): () => void {
  const onNavigate = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;

    const intent = detail as { target?: unknown; mapId?: unknown };
    if (intent.target === 'overview') {
      listener({ target: 'overview' });
      return;
    }

    if (
      intent.target === 'map' &&
      typeof intent.mapId === 'string' &&
      intent.mapId.trim().length > 0
    ) {
      listener({ target: 'map', mapId: intent.mapId });
    }
  };

  window.addEventListener(CONTEXT_NAVIGATION_EVENT, onNavigate);
  subscriptions.add(onNavigate);
  if (pendingNavigation) {
    const intent = pendingNavigation;
    pendingNavigation = null;
    onNavigate(new CustomEvent(CONTEXT_NAVIGATION_EVENT, { detail: intent }));
  }
  return () => {
    subscriptions.delete(onNavigate);
    window.removeEventListener(CONTEXT_NAVIGATION_EVENT, onNavigate);
  };
}
