import * as React from 'react';

import { useUIStore, type Route } from '@/stores/ui';
import {
  resolveChatEngine,
  useBrowserChatStore,
  type VibeSpaceChatEngine,
} from './browserChatStore';
import { browserChatSurface, type ProviderSurfaceController } from './providerSurface';

type BrowserChatSurfaceRuntime = Pick<ProviderSurfaceController, 'hideAll'>;

interface BrowserChatSurfaceGuardProps {
  readonly runtime?: BrowserChatSurfaceRuntime;
}

export function shouldShowBrowserChatSurface(input: {
  readonly route: Route;
  readonly engine: VibeSpaceChatEngine;
  readonly chatId?: string | null;
}): boolean {
  return (
    input.route === 'chat' &&
    input.engine === 'browser' &&
    typeof input.chatId === 'string' &&
    input.chatId.length > 0
  );
}

/**
 * Desktop-only route authority for provider child WebViews.
 *
 * PageRouter intentionally defers route rendering for smooth transitions. A
 * provider WebView is native and therefore cannot depend on that deferred React
 * teardown. This guard reads the immediate route/engine and hides every Browser
 * Chat child before another route can paint. Account/profile changes are owned
 * by BrowserProviderSurface while Browser Chat is visible; keeping account
 * identity out of this global guard avoids coupling Browser Chat to app boot.
 */
export function BrowserChatSurfaceGuard({
  runtime = browserChatSurface,
}: BrowserChatSurfaceGuardProps) {
  const route = useUIStore((state) => state.route);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const engine = useBrowserChatStore((state) => resolveChatEngine(state, activeChatId));
  const visible = shouldShowBrowserChatSurface({ route, engine, chatId: activeChatId });

  React.useLayoutEffect(() => {
    if (!visible) {
      void runtime.hideAll().catch(() => undefined);
    }
  }, [runtime, visible]);

  React.useEffect(
    () => () => {
      void runtime.hideAll().catch(() => undefined);
    },
    [runtime],
  );

  return null;
}
