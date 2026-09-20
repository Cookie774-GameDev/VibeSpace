import { useFullscreenStore } from '@/features/fullscreen/fullscreenStore';
import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import { isSettingsTab, type SettingsTab } from '@/features/settings/settingsPrefetch';
import { rememberSettingsTab } from '@/features/settings/settingsTabMemory';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { InstantResult } from '../types';
import {
  openProviderConnectionEntrypoint,
  parseProviderConnectionTarget,
} from '../providerConnectionEntrypoint';

export type NavigationCommandRequest = Readonly<{
  id: string;
  slots: Readonly<Record<string, unknown>>;
}>;

export type NavigationAuthorityPort = Readonly<{
  openRoute: (route: Route) => void;
  hasSelectedAgent: () => boolean;
  hasSelectedProject: () => boolean;
  goBack: () => void;
  goForward: () => void;
  openSettings: (section?: SettingsTab) => void;
  openProviderConnections?: (target?: string) => void;
  closeSettings: () => void;
  openPalette: () => void;
  openLauncher: () => void;
  setFullscreen: (enabled: boolean) => Promise<boolean>;
}>;

const ROUTES = new Set<string>(APP_ROUTES);
const NAVIGATION_COMMANDS = new Set([
  'page.open',
  'page.back',
  'page.forward',
  'page.home',
  'settings.open',
  'settings.close',
  'settings.section.open',
  'connections.open',
  'palette.open',
  'launcher.open',
  'fullscreen.set',
]);

const defaultPort: NavigationAuthorityPort = {
  openRoute: (route) => useUIStore.getState().setRoute(route),
  hasSelectedAgent: () => Boolean(useUIStore.getState().activeAgentId),
  hasSelectedProject: () => Boolean(useAuthStore.getState().projectId),
  goBack: () => window.history.back(),
  goForward: () => window.history.forward(),
  openSettings: (section) => {
    const state = useUIStore.getState();
    const wasOpen = state.settingsOpen;
    if (section) rememberSettingsTab(section);
    state.setSettingsOpen(true);
    if (section && wasOpen) {
      window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: section } }));
    }
  },
  openProviderConnections: (target) => {
    const result = openProviderConnectionEntrypoint(target);
    if (!result.ok) throw new Error('provider_connection_target_invalid');
  },
  closeSettings: () => useUIStore.getState().setSettingsOpen(false),
  openPalette: () => useUIStore.getState().setPaletteOpen(true),
  openLauncher: () => useUIStore.getState().setLauncherOpen(true),
  setFullscreen: (enabled) => useFullscreenStore.getState().requestSystemActive(enabled),
};

function success(message: string): InstantResult {
  return { ok: true, code: 'opened', message };
}

function invalid(message: string, code: 'target_missing' | 'queue_failed' = 'queue_failed') {
  return { ok: false as const, code, message };
}

function hasExactKeys(slots: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(slots).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validSlotSchema(request: NavigationCommandRequest): boolean {
  if (!request.slots || typeof request.slots !== 'object' || Array.isArray(request.slots)) {
    return false;
  }
  if (request.id === 'page.open') return hasExactKeys(request.slots, ['route']);
  if (request.id === 'settings.section.open') return hasExactKeys(request.slots, ['section']);
  if (request.id === 'fullscreen.set') return hasExactKeys(request.slots, ['enabled']);
  if (request.id === 'connections.open') {
    return (
      hasExactKeys(request.slots, []) ||
      hasExactKeys(request.slots, ['section']) ||
      hasExactKeys(request.slots, ['providerId', 'section']) ||
      hasExactKeys(request.slots, ['connectionId', 'section'])
    );
  }
  return hasExactKeys(request.slots, []);
}

async function executeNavigationCommandUnsafe(
  request: NavigationCommandRequest,
  port: NavigationAuthorityPort = defaultPort,
  signal?: AbortSignal,
): Promise<InstantResult> {
  if (signal?.aborted) return invalid('The instant command deadline elapsed.');
  if (typeof request.id !== 'string' || !NAVIGATION_COMMANDS.has(request.id)) {
    return invalid('That navigation command is not implemented.');
  }
  if (!validSlotSchema(request)) {
    return invalid(
      request.id === 'connections.open'
        ? 'Provider connections do not accept command arguments.'
        : 'Navigation command arguments are invalid.',
    );
  }

  if (request.id === 'page.open') {
    const route = request.slots.route;
    if (typeof route !== 'string' || !ROUTES.has(route)) return invalid('Unknown page target.');
    if (route === 'agent-detail' && !port.hasSelectedAgent()) {
      return invalid('Select one agent before opening agent details.', 'target_missing');
    }
    if (route === 'project-detail' && !port.hasSelectedProject()) {
      return invalid('Select one project before opening project details.', 'target_missing');
    }
    port.openRoute(route as Route);
    return success(`Opened ${route}.`);
  }
  if (request.id === 'page.back') {
    port.goBack();
    return success('Went back.');
  }
  if (request.id === 'page.forward') {
    port.goForward();
    return success('Went forward.');
  }
  if (request.id === 'page.home') {
    port.openRoute('chat');
    return success('Opened home.');
  }
  if (request.id === 'settings.open') {
    port.openSettings();
    return success('Opened Settings.');
  }
  if (request.id === 'settings.close') {
    port.closeSettings();
    return success('Closed Settings.');
  }
  if (request.id === 'settings.section.open') {
    const section = request.slots.section;
    if (typeof section !== 'string' || !isSettingsTab(section)) {
      return invalid('Unknown Settings section.');
    }
    port.openSettings(section);
    return success(`Opened Settings → ${section}.`);
  }
  if (request.id === 'connections.open') {
    const keys = Object.keys(request.slots);
    if (
      (keys.length > 0 &&
        request.slots.section !== 'providers' &&
        request.slots.section !== 'connections') ||
      keys.some((key) => key !== 'section' && key !== 'providerId' && key !== 'connectionId')
    ) {
      return invalid('Provider connections do not accept command arguments.');
    }
    const targetValue = request.slots.connectionId ?? request.slots.providerId;
    const target = parseProviderConnectionTarget(targetValue);
    if (!target.ok) return invalid(target.reason);
    if (target.connectionId && request.slots.section !== 'connections') {
      return invalid('CLI connections require the Connections surface.');
    }
    if (target.providerId && request.slots.section !== 'providers') {
      return invalid('Provider keys require the Providers surface.');
    }
    if (port.openProviderConnections) {
      port.openProviderConnections(target.connectionId ?? target.providerId);
    } else if (!target.providerId) {
      port.openSettings(request.slots.section === 'providers' ? 'providers' : 'connections');
    } else {
      return invalid('Choose one supported provider in Settings.');
    }
    return success(
      target.connectionId
        ? `Opened ${target.connectionId} connections.`
        : target.providerId
        ? `Opened provider connections for ${target.providerId}.`
        : 'Opened provider connections.',
    );
  }
  if (request.id === 'palette.open') {
    port.openPalette();
    return success('Opened command palette.');
  }
  if (request.id === 'launcher.open') {
    port.openLauncher();
    return success('Opened quick launcher.');
  }
  if (request.id === 'fullscreen.set') {
    const enabled = request.slots.enabled;
    if (typeof enabled !== 'boolean') return invalid('Say fullscreen on or off.');
    const observed = await port.setFullscreen(enabled);
    if (signal?.aborted) return invalid('The instant command deadline elapsed.');
    if (typeof observed !== 'boolean') return invalid('Fullscreen state is unavailable.');
    if (observed !== enabled) {
      return invalid(`Fullscreen remained ${observed ? 'on' : 'off'}.`);
    }
    return success(`Fullscreen ${observed ? 'on' : 'off'}.`);
  }
  return invalid('That navigation command is not implemented.');
}

export async function executeNavigationCommand(
  request: NavigationCommandRequest,
  port: NavigationAuthorityPort = defaultPort,
  signal?: AbortSignal,
): Promise<InstantResult> {
  try {
    return await executeNavigationCommandUnsafe(request, port, signal);
  } catch {
    return invalid('Navigation command failed.');
  }
}
