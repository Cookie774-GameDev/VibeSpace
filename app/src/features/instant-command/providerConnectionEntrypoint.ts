import { rememberSettingsTab } from '@/features/settings/settingsTabMemory';
import { useUIStore } from '@/stores/ui';

export const PROVIDER_FOCUS_STORAGE_KEY = 'vibespace.settings.provider-focus.v1';
export const CONNECTION_FOCUS_STORAGE_KEY = 'vibespace.settings.connection-focus.v1';
export const CONNECT_PROVIDER_FOCUS_IDS = Object.freeze([
  'anthropic',
  'deepseek',
  'google',
  'groq',
  'mistral',
  'openai',
  'openrouter',
  'qwen',
  'together',
  'xai',
] as const);

export const CONNECT_CONNECTION_FOCUS_IDS = Object.freeze([
  'openai-codex',
  'opencode-cli',
] as const);

export type ConnectProviderFocusId = (typeof CONNECT_PROVIDER_FOCUS_IDS)[number];
export type ConnectConnectionFocusId = (typeof CONNECT_CONNECTION_FOCUS_IDS)[number];

const PROVIDER_IDS = new Set<string>(CONNECT_PROVIDER_FOCUS_IDS);
const CONNECTION_IDS = new Set<string>(CONNECT_CONNECTION_FOCUS_IDS);
const CONNECTION_ALIASES: Readonly<Record<string, ConnectConnectionFocusId>> = Object.freeze({
  codex: 'openai-codex',
  opencode: 'opencode-cli',
});
const REJECTION = 'Choose one supported provider in Settings.';

export type ProviderConnectionTargetResult =
  | Readonly<{
      ok: true;
      providerId: ConnectProviderFocusId | undefined;
      connectionId?: ConnectConnectionFocusId;
    }>
  | Readonly<{ ok: false; reason: typeof REJECTION }>;

export interface ProviderConnectionEntrypointPort {
  isSettingsOpen(): boolean;
  rememberProviders(): void;
  rememberConnections(): void;
  persistProviderFocus(providerId: ConnectProviderFocusId): void;
  persistConnectionFocus(connectionId: ConnectConnectionFocusId): void;
  setSettingsOpen(open: boolean): void;
  emitProvidersTab(): void;
  emitConnectionsTab(): void;
  emitProviderFocus(providerId: ConnectProviderFocusId): void;
  emitConnectionFocus(connectionId: ConnectConnectionFocusId): void;
  schedule(callback: () => void): void;
}

export function parseProviderConnectionTarget(raw: unknown): ProviderConnectionTargetResult {
  if (raw === undefined || raw === null || raw === '') {
    return Object.freeze({ ok: true, providerId: undefined });
  }
  if (
    typeof raw !== 'string' ||
    raw !== raw.trim() ||
    raw.length > 96 ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(raw) ||
    (!PROVIDER_IDS.has(raw) && !CONNECTION_IDS.has(raw) && !CONNECTION_ALIASES[raw])
  ) {
    return Object.freeze({ ok: false, reason: REJECTION });
  }
  const connectionId = CONNECTION_ALIASES[raw] ??
    (CONNECTION_IDS.has(raw) ? (raw as ConnectConnectionFocusId) : undefined);
  if (connectionId) return Object.freeze({ ok: true, providerId: undefined, connectionId });
  return Object.freeze({ ok: true, providerId: raw as ConnectProviderFocusId });
}

const browserPort: ProviderConnectionEntrypointPort = Object.freeze({
  isSettingsOpen: () => useUIStore.getState().settingsOpen,
  rememberProviders: () => rememberSettingsTab('providers'),
  rememberConnections: () => rememberSettingsTab('connections'),
  persistProviderFocus: (providerId: ConnectProviderFocusId) =>
    window.sessionStorage.setItem(PROVIDER_FOCUS_STORAGE_KEY, providerId),
  persistConnectionFocus: (connectionId: ConnectConnectionFocusId) =>
    window.sessionStorage.setItem(CONNECTION_FOCUS_STORAGE_KEY, connectionId),
  setSettingsOpen: (open: boolean) => useUIStore.getState().setSettingsOpen(open),
  emitProvidersTab: () =>
    window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: 'providers' } })),
  emitConnectionsTab: () =>
    window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: 'connections' } })),
  emitProviderFocus: (providerId: ConnectProviderFocusId) =>
    window.dispatchEvent(new CustomEvent('jarvis:settings:provider', { detail: { providerId } })),
  emitConnectionFocus: (connectionId: ConnectConnectionFocusId) =>
    window.dispatchEvent(
      new CustomEvent('jarvis:settings:connection', { detail: { connectionId } }),
    ),
  schedule: (callback: () => void) => window.setTimeout(callback, 0),
});

export function openProviderConnectionEntrypoint(
  providerId?: string,
  port: Readonly<ProviderConnectionEntrypointPort> = browserPort,
): Readonly<{ ok: true }> | Readonly<{ ok: false; reason: typeof REJECTION }> {
  const parsed = parseProviderConnectionTarget(providerId);
  if (!parsed.ok) return parsed;

  const wasOpen = port.isSettingsOpen();
  const connectionId = parsed.connectionId;
  const openConnections = Boolean(connectionId) || parsed.providerId === undefined;
  if (openConnections) {
    port.rememberConnections();
    if (connectionId) {
      try {
        port.persistConnectionFocus(connectionId);
      } catch {
        // Focus is optional; the secure Connections surface must still open.
      }
    }
  } else {
    port.rememberProviders();
  }
  if (parsed.providerId) {
    try {
      port.persistProviderFocus(parsed.providerId);
    } catch {
      // Focus is optional; the secure Providers surface must still open.
    }
  }
  port.setSettingsOpen(true);

  const emit = () => {
    if (openConnections) {
      port.emitConnectionsTab();
      if (connectionId) port.emitConnectionFocus(connectionId);
    } else {
      port.emitProvidersTab();
      if (parsed.providerId) port.emitProviderFocus(parsed.providerId);
    }
  };
  if (wasOpen) emit();
  else port.schedule(emit);
  return Object.freeze({ ok: true });
}
