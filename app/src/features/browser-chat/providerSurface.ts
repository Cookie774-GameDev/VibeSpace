import type { WebviewOptions } from '@tauri-apps/api/webview';

import { isTauri } from '@/lib/utils';
import { openExternal } from '@/lib/tauri';
import {
  BROWSER_CHAT_PROVIDERS,
  isBrowserChatProviderId,
  type BrowserChatProviderDefinition,
  type BrowserChatProviderId,
} from './providerRegistry';
import { CHATGPT_PLUGINS_URL } from './mcpConnection';
import { normalizeProviderNavigation, type ProviderNavigationKind } from './providerNavigation';
import {
  isBrowserChatAccountProfileKey,
  type BrowserChatAccountProfileKey,
} from './providerProfileScope';

export const BROWSER_CHAT_PROVIDER_NAVIGATION_EVENT = 'browser-chat://navigation';
export const BROWSER_CHAT_PROVIDER_LOAD_EVENT = 'browser-chat://load';
const NATIVE_OPEN_TIMEOUT_MS = 30_000;

function requirePageId(pageId: unknown): string {
  if (
    typeof pageId !== 'string' ||
    pageId.length === 0 ||
    pageId.length > 160 ||
    pageId.trim() !== pageId ||
    /[\u0000-\u001f\u007f]/u.test(pageId)
  ) {
    throw new Error('Browser Chat page ID is unavailable.');
  }
  return pageId;
}

function browserChatProviderSurfaceId(providerId: BrowserChatProviderId): string {
  return `browser-chat-${providerId}`;
}

export interface ProviderSurfaceNavigation {
  readonly providerId: BrowserChatProviderId;
  readonly surfaceId: string;
  readonly accountProfileKey: BrowserChatAccountProfileKey;
  readonly pageId: string;
  readonly url: string;
  readonly timestamp: number;
  readonly kind: ProviderNavigationKind;
  readonly providerConversationKey?: string;
  readonly providerProjectKey?: string;
}

export interface NativeProviderSurfaceNavigation {
  readonly providerId: string;
  readonly surfaceId: string;
  readonly accountProfileKey: string;
  readonly pageId: string;
  readonly url: string;
  readonly timestamp: number;
  readonly kind: string;
}

export interface NativeProviderSurfaceLoad {
  readonly providerId: string;
  readonly accountProfileKey: string;
  readonly pageId: string;
  readonly phase: 'started' | 'finished';
}

export function normalizeProviderSurfaceNavigation(
  providerId: BrowserChatProviderId,
  accountProfileKey: BrowserChatAccountProfileKey,
  rawUrl: string,
  timestamp: number = Date.now(),
  pageId: string = 'default',
): ProviderSurfaceNavigation | null {
  const navigation = normalizeProviderNavigation(providerId, rawUrl);
  if (!navigation) return null;
  return {
    providerId,
    surfaceId: browserChatProviderSurfaceId(providerId),
    accountProfileKey,
    pageId,
    url: navigation.normalizedUrl,
    timestamp,
    kind: navigation.kind,
    ...(navigation.conversationKey ? { providerConversationKey: navigation.conversationKey } : {}),
    ...(navigation.projectKey ? { providerProjectKey: navigation.projectKey } : {}),
  };
}

export interface ProviderSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ManagedProviderSurface {
  readonly label: string;
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  setPosition(position: { x: number; y: number }): Promise<void>;
  setSize(size: { width: number; height: number }): Promise<void>;
  setNavigationUrl?(url: string | undefined): Promise<void>;
}

export interface ProviderSurfacePlatform {
  readonly desktop: boolean;
  getSurface(
    label: string,
    profileKey?: string,
    pageId?: string,
  ): Promise<ManagedProviderSurface | null>;
  createSurface(
    label: string,
    options: WebviewOptions,
    profileKey?: string,
    pageId?: string,
  ): ManagedProviderSurface | Promise<ManagedProviderSurface>;
  openExternal(url: string): Promise<void>;
  hideAllSurfaces?(): Promise<void>;
  subscribeHostGeometry?(listener: () => void): Promise<() => void>;
  subscribeNavigation?(
    listener: (navigation: NativeProviderSurfaceNavigation) => void,
  ): Promise<() => void>;
  subscribeLoad?(listener: (load: NativeProviderSurfaceLoad) => void): Promise<() => void>;
}

export interface ProviderSurfaceController {
  openManaged(
    provider: BrowserChatProviderDefinition,
    bounds: ProviderSurfaceBounds,
    navigationUrl?: string,
    accountProfileKey?: BrowserChatAccountProfileKey,
    pageId?: string,
  ): Promise<
    | { kind: 'managed'; providerId: BrowserChatProviderId; loaded?: boolean }
    | { kind: 'embedded_frame'; providerId: BrowserChatProviderId; url: string }
  >;
  openSystemBrowser(provider: BrowserChatProviderDefinition): Promise<void>;
  openExternalNavigation(
    provider: BrowserChatProviderDefinition,
    navigationUrl: string,
  ): Promise<void>;
  openChatGptPlugins(): Promise<void>;
  hideAll(): Promise<void>;
  subscribeHostGeometry?(listener: () => void): Promise<() => void>;
  subscribeNavigation?(
    listener: (navigation: ProviderSurfaceNavigation) => void,
  ): Promise<() => void>;
  subscribeLoad?(listener: (load: NativeProviderSurfaceLoad) => void): Promise<() => void>;
}

export type NativeBrowserChatInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function requireAccountProfileKey(profileKey: unknown): BrowserChatAccountProfileKey {
  if (!isBrowserChatAccountProfileKey(profileKey)) {
    throw new Error('Browser Chat account profile key is unavailable.');
  }
  return profileKey;
}

export function createNativeManagedProviderSurface(
  label: string,
  invoke: NativeBrowserChatInvoke,
  profileKey: BrowserChatAccountProfileKey,
  pageId: string = 'default',
): ManagedProviderSurface {
  const provider = BROWSER_CHAT_PROVIDERS.find((candidate) => candidate.windowLabel === label);
  if (!provider) {
    throw new Error('Unsupported Browser Chat provider window label.');
  }
  const providerProfileKey = requireAccountProfileKey(profileKey);
  const browserPageId = requirePageId(pageId);
  let navigationUrl: string | undefined;
  let bounds: ProviderSurfaceBounds = {
    x: Number.NaN,
    y: Number.NaN,
    width: Number.NaN,
    height: Number.NaN,
  };

  return {
    label,
    async show() {
      assertBounds(bounds);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const opening = invoke('browser_chat_surface_open', {
        providerId: provider.id,
        providerProfileKey,
        pageId: browserPageId,
        bounds,
        ...(navigationUrl ? { navigationUrl } : {}),
      });
      try {
        await Promise.race([
          opening,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              // Invalidate a late native creation so it cannot cover another VibeSpace page.
              void invoke('browser_chat_surface_hide_all').catch(() => undefined);
              reject(new Error('Browser Chat did not open within 30 seconds.'));
            }, NATIVE_OPEN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      navigationUrl = undefined;
    },
    async hide() {
      await invoke('browser_chat_surface_hide', {
        providerId: provider.id,
        providerProfileKey,
        pageId: browserPageId,
      });
    },
    async setFocus() {
      // The guarded native open command focuses only on creation/activation.
      // Geometry-only updates never steal focus from the VibeSpace shell.
    },
    async setPosition(position) {
      bounds = { ...bounds, ...position };
    },
    async setSize(size) {
      bounds = { ...bounds, ...size };
    },
    async setNavigationUrl(url) {
      navigationUrl = url;
    },
  };
}

function assertBounds(bounds: ProviderSurfaceBounds): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    throw new Error('Browser Chat bounds must be finite and non-zero.');
  }
}

export function createProviderSurfaceController(
  platform: ProviderSurfacePlatform,
): ProviderSurfaceController {
  const pendingCreations = new Map<string, Promise<ManagedProviderSurface>>();
  const knownSurfaces = new Map<
    string,
    {
      readonly providerId: BrowserChatProviderId;
      readonly label: string;
      readonly accountProfileKey: BrowserChatAccountProfileKey;
      readonly pageId: string;
    }
  >();
  const lastRequestedNavigation = new Map<string, string>();
  const loadedPages = new Set<string>();
  let operationTail: Promise<void> = Promise.resolve();
  let visibilityGeneration = 0;

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const hideExcept = async (selectedSurfaceKey?: string) => {
    await Promise.all(
      [...knownSurfaces.entries()]
        .filter(([surfaceKey]) => surfaceKey !== selectedSurfaceKey)
        .map(async ([, surfaceRecord]) => {
          const surface = await platform.getSurface(
            surfaceRecord.label,
            surfaceRecord.accountProfileKey,
            surfaceRecord.pageId,
          );
          if (surface) await surface.hide();
        }),
    );
  };

  return {
    async openManaged(
      provider,
      bounds,
      requestedNavigationUrl,
      requestedAccountProfileKey,
      requestedPageId,
    ) {
      const requestedGeneration = visibilityGeneration;
      return serialized(async () => {
        assertBounds(bounds);
        if (!BROWSER_CHAT_PROVIDERS.includes(provider)) {
          throw new Error('Unsupported Browser Chat provider definition.');
        }
        const accountProfileKey = requireAccountProfileKey(requestedAccountProfileKey);
        const pageId = requirePageId(requestedPageId ?? 'default');
        const navigation = normalizeProviderNavigation(
          provider.id,
          requestedNavigationUrl ?? provider.homeUrl,
        );
        if (!navigation) {
          throw new Error('browser_chat_provider_navigation_invalid');
        }
        const targetUrl = navigation.normalizedUrl;
        if (!platform.desktop) {
          return { kind: 'embedded_frame' as const, providerId: provider.id, url: targetUrl };
        }

        const relative = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
        const surfaceKey = `${provider.windowLabel}:${accountProfileKey}:${pageId}`;
        await hideExcept(surfaceKey);
        let surface = await platform.getSurface(provider.windowLabel, accountProfileKey, pageId);
        if (!surface) {
          let pending = pendingCreations.get(surfaceKey);
          if (!pending) {
            pending = Promise.resolve(
              platform.createSurface(
                provider.windowLabel,
                {
                  url: targetUrl,
                  dataDirectory: accountProfileKey,
                  x: relative.x,
                  y: relative.y,
                  width: relative.width,
                  height: relative.height,
                  focus: false,
                },
                accountProfileKey,
                pageId,
              ),
            );
            pendingCreations.set(surfaceKey, pending);
          }
          try {
            surface = await pending;
          } finally {
            if (pendingCreations.get(surfaceKey) === pending) {
              pendingCreations.delete(surfaceKey);
            }
          }
        }

        knownSurfaces.set(surfaceKey, {
          providerId: provider.id,
          label: provider.windowLabel,
          accountProfileKey,
          pageId,
        });
        await surface.setPosition({ x: relative.x, y: relative.y });
        await surface.setSize({ width: relative.width, height: relative.height });
        if (lastRequestedNavigation.get(surfaceKey) !== targetUrl) {
          await surface.setNavigationUrl?.(targetUrl);
          loadedPages.delete(surfaceKey);
        }

        // A route-leave hide increments the generation immediately, even while
        // native creation is still in flight. Never allow that stale open to
        // become visible after the user has already left Browser Chat.
        if (requestedGeneration !== visibilityGeneration) {
          await surface.hide();
          return { kind: 'managed' as const, providerId: provider.id, loaded: false };
        }

        await surface.show();
        lastRequestedNavigation.set(surfaceKey, targetUrl);
        if (requestedGeneration !== visibilityGeneration) {
          await surface.hide();
          return { kind: 'managed' as const, providerId: provider.id, loaded: false };
        }
        await surface.setFocus();
        return {
          kind: 'managed' as const,
          providerId: provider.id,
          loaded: loadedPages.has(surfaceKey),
        };
      });
    },

    async openSystemBrowser(provider) {
      if (!BROWSER_CHAT_PROVIDERS.includes(provider)) {
        throw new Error('Unsupported Browser Chat provider definition.');
      }
      await platform.openExternal(provider.homeUrl);
    },

    async openExternalNavigation(provider, navigationUrl) {
      if (!BROWSER_CHAT_PROVIDERS.includes(provider)) {
        throw new Error('Unsupported Browser Chat provider definition.');
      }
      const navigation = normalizeProviderNavigation(provider.id, navigationUrl);
      if (!navigation) {
        throw new Error('browser_chat_provider_navigation_invalid');
      }
      await platform.openExternal(navigation.normalizedUrl);
    },

    async openChatGptPlugins() {
      await platform.openExternal(CHATGPT_PLUGINS_URL);
    },

    async hideAll() {
      visibilityGeneration += 1;
      await serialized(async () => {
        if (platform.hideAllSurfaces) {
          await platform.hideAllSurfaces();
        } else {
          await hideExcept();
        }
        knownSurfaces.clear();
        // Parked native pages retain their current navigation across tab switches.
        if (!platform.desktop) lastRequestedNavigation.clear();
      });
    },

    async subscribeHostGeometry(listener) {
      return platform.subscribeHostGeometry?.(listener) ?? (() => undefined);
    },

    async subscribeNavigation(listener) {
      return (
        (await platform.subscribeNavigation?.((event) => {
          if (
            !isBrowserChatProviderId(event.providerId) ||
            !isBrowserChatAccountProfileKey(event.accountProfileKey) ||
            typeof event.pageId !== 'string' ||
            !Number.isFinite(event.timestamp) ||
            event.timestamp < 0
          ) {
            return;
          }
          const expectedSurfaceId = browserChatProviderSurfaceId(event.providerId);
          if (event.surfaceId !== expectedSurfaceId) return;
          const normalized = normalizeProviderSurfaceNavigation(
            event.providerId,
            event.accountProfileKey,
            event.url,
            event.timestamp,
            event.pageId,
          );
          if (!normalized || normalized.kind !== event.kind) return;
          const surfaceKey = `${expectedSurfaceId}:${event.accountProfileKey}:${event.pageId}`;
          lastRequestedNavigation.set(surfaceKey, normalized.url);
          listener(normalized);
        })) ?? (() => undefined)
      );
    },

    async subscribeLoad(listener) {
      return (
        (await platform.subscribeLoad?.((event) => {
          if (
            !isBrowserChatProviderId(event.providerId) ||
            !isBrowserChatAccountProfileKey(event.accountProfileKey) ||
            typeof event.pageId !== 'string' ||
            !['started', 'finished'].includes(event.phase)
          ) {
            return;
          }
          const surfaceKey = `${browserChatProviderSurfaceId(event.providerId)}:${event.accountProfileKey}:${event.pageId}`;
          if (event.phase === 'finished') loadedPages.add(surfaceKey);
          else loadedPages.delete(surfaceKey);
          listener(event);
        })) ?? (() => undefined)
      );
    },
  };
}

async function defaultPlatform(): Promise<ProviderSurfacePlatform> {
  if (!isTauri) {
    return {
      desktop: false,
      getSurface: async () => null,
      createSurface: () => {
        throw new Error('Managed provider surfaces require the VibeSpace desktop app.');
      },
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    };
  }

  const [{ invoke }, { getCurrentWindow }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ]);
  const currentWindow = getCurrentWindow();
  const nativeInvoke: NativeBrowserChatInvoke = (command, args) => invoke(command, args);
  const managedSurfaces = new Map<string, ManagedProviderSurface>();
  const surfaceKey = (label: string, profileKey: unknown, pageId: unknown) =>
    `${label}:${requireAccountProfileKey(profileKey)}:${requirePageId(pageId ?? 'default')}`;

  return {
    desktop: true,
    async getSurface(label, profileKey, pageId) {
      const key = surfaceKey(label, profileKey, pageId);
      let surface = managedSurfaces.get(key);
      if (!surface) {
        surface = createNativeManagedProviderSurface(
          label,
          nativeInvoke,
          requireAccountProfileKey(profileKey),
          requirePageId(pageId ?? 'default'),
        );
        managedSurfaces.set(key, surface);
      }
      return surface;
    },
    async createSurface(label, options, profileKey, pageId) {
      const accountProfileKey = requireAccountProfileKey(profileKey);
      const browserPageId = requirePageId(pageId ?? 'default');
      const key = surfaceKey(label, accountProfileKey, browserPageId);
      const surface = createNativeManagedProviderSurface(
        label,
        nativeInvoke,
        accountProfileKey,
        browserPageId,
      );
      await surface.setPosition({ x: options.x, y: options.y });
      await surface.setSize({ width: options.width, height: options.height });
      await surface.setNavigationUrl?.(typeof options.url === 'string' ? options.url : undefined);
      managedSurfaces.set(key, surface);
      return surface;
    },
    async hideAllSurfaces() {
      await nativeInvoke('browser_chat_surface_hide_all');
      managedSurfaces.clear();
    },
    openExternal,
    async subscribeHostGeometry(listener) {
      const [unlistenMoved, unlistenScale] = await Promise.all([
        currentWindow.onMoved(listener),
        currentWindow.onScaleChanged(listener),
      ]);
      return () => {
        unlistenMoved();
        unlistenScale();
      };
    },
    async subscribeNavigation(listener) {
      return listen<NativeProviderSurfaceNavigation>(
        BROWSER_CHAT_PROVIDER_NAVIGATION_EVENT,
        (event) => listener(event.payload),
      );
    },
    async subscribeLoad(listener) {
      return listen<NativeProviderSurfaceLoad>(BROWSER_CHAT_PROVIDER_LOAD_EVENT, (event) =>
        listener(event.payload),
      );
    },
  };
}

let defaultController: Promise<ProviderSurfaceController> | null = null;

async function controller(): Promise<ProviderSurfaceController> {
  defaultController ??= defaultPlatform().then(createProviderSurfaceController);
  return defaultController;
}

export const browserChatSurface: ProviderSurfaceController = {
  async openManaged(provider, bounds, navigationUrl, accountProfileKey, pageId) {
    return (await controller()).openManaged(
      provider,
      bounds,
      navigationUrl,
      accountProfileKey,
      pageId,
    );
  },
  async openSystemBrowser(provider) {
    return (await controller()).openSystemBrowser(provider);
  },
  async openExternalNavigation(provider, navigationUrl) {
    return (await controller()).openExternalNavigation(provider, navigationUrl);
  },
  async openChatGptPlugins() {
    return (await controller()).openChatGptPlugins();
  },
  async hideAll() {
    return (await controller()).hideAll();
  },
  async subscribeHostGeometry(listener) {
    return (await controller()).subscribeHostGeometry?.(listener) ?? (() => undefined);
  },
  async subscribeNavigation(listener) {
    return (await controller()).subscribeNavigation?.(listener) ?? (() => undefined);
  },
  async subscribeLoad(listener) {
    return (await controller()).subscribeLoad?.(listener) ?? (() => undefined);
  },
};
