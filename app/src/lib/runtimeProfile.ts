/**
 * Fail-closed frontend runtime-profile authority for the MonoChrome visual-test
 * session (MonoChrome plan §16).
 *
 * This module parses ONLY the compile-time frontend signal
 * `VITE_VIBESPACE_RUNTIME_PROFILE` (statically replaced by Vite). It never reads
 * the native process signal `VIBESPACE_RUNTIME_PROFILE` — that signal is owned by
 * the Rust `runtime_profile.rs` boundary. The two boundaries are proven to agree
 * through the `runtime_profile_query` handshake below.
 *
 * Valid frontend states:
 *   - absent (undefined / null)          -> ordinary production behavior
 *   - exact `monochrome-visual-test`     -> minimal visual-test side-effect deny mode
 *   - every other value, including empty -> throws before React boot
 *
 * The profile is a side-effect deny mode, not an alternate product identity: the
 * UI tree still renders for visual capture, but every enumerated boot effect and
 * effect host is suppressed before the first awaited boot boundary.
 */
import { MONOCHROME_PRIMITIVE_MANIFEST } from '@/features/appearance/monochromePrimitiveManifest';

/** The compile-time frontend signal name (never the native signal). */
export const RUNTIME_PROFILE_ENV = 'VITE_VIBESPACE_RUNTIME_PROFILE' as const;

/** The exact accepted visual-test profile value (paired with the native boundary). */
export const MONOCHROME_VISUAL_TEST = 'monochrome-visual-test' as const;
export const MONOCHROME_DEVELOPMENT_AUTHORITY_ID = 'development:monochrome-workbench' as const;

/** The native command used to prove frontend/native agreement before fixtures. */
export const RUNTIME_PROFILE_QUERY_COMMAND = 'runtime_profile_query' as const;
export const RUNTIME_PROFILE_QUERY_TIMEOUT_MS = 30_000 as const;
export const MONOCHROME_EVIDENCE_COMMIT_COMMAND = 'monochrome_evidence_commit' as const;
export const MONOCHROME_EVIDENCE_SCHEMA_VERSION =
  'vibespace.monochrome.native-evidence.v1' as const;
export const MONOCHROME_DENIED_EFFECT_MANIFEST_HASH =
  '24d75985399db9fb179ac64a10b982801fcb7681bf3f13a5a62d2340fa04850c' as const;

export const MONOCHROME_APP_IDENTIFIER_ENV = 'VITE_VIBESPACE_MONOCHROME_APP_IDENTIFIER' as const;
export const MONOCHROME_CAPABILITY_IDENTIFIER_ENV =
  'VITE_VIBESPACE_MONOCHROME_CAPABILITY_IDENTIFIER' as const;
export const MONOCHROME_SESSION_NONCE_HASH_ENV =
  'VITE_VIBESPACE_MONOCHROME_SESSION_NONCE_HASH' as const;

export type RuntimeProfileKind = 'ordinary' | typeof MONOCHROME_VISUAL_TEST;

export interface RuntimeProfile {
  readonly kind: RuntimeProfileKind;
  readonly isOrdinary: boolean;
  readonly isVisualTest: boolean;
}

/**
 * Capability plan derived from the resolved profile. Every `*Enabled` flag is
 * `true` in ordinary mode (production behavior preserved byte-for-byte) and
 * `false` in visual-test mode (the named effect host is suppressed before its
 * first effect).
 */
export interface RuntimePlan {
  readonly profile: RuntimeProfile;
  readonly isOrdinary: boolean;
  readonly isVisualTest: boolean;
  readonly vaultKeychainHydrationEnabled: boolean;
  readonly terminalLauncherInstallEnabled: boolean;
  readonly cloudSyncEnabled: boolean;
  readonly updateChecksEnabled: boolean;
  readonly nativeNotificationsEnabled: boolean;
  readonly backgroundServicesEnabled: boolean;
  readonly persistenceEnabled: boolean;
  readonly agentRuntimeEnabled: boolean;
  readonly kernelEnabled: boolean;
  readonly lifecycleEnabled: boolean;
  readonly globalHotkeyEnabled: boolean;
  readonly idleEnabled: boolean;
  readonly analyticsEnabled: boolean;
  readonly wakeWordEnabled: boolean;
  readonly petEnabled: boolean;
  readonly sttEnabled: boolean;
  readonly terminalCliEnabled: boolean;
  readonly devConsoleEnabled: boolean;
  readonly updateEffectsEnabled: boolean;
}

const ORDINARY_PROFILE: RuntimeProfile = Object.freeze({
  kind: 'ordinary',
  isOrdinary: true,
  isVisualTest: false,
});

const VISUAL_TEST_PROFILE: RuntimeProfile = Object.freeze({
  kind: MONOCHROME_VISUAL_TEST,
  isOrdinary: false,
  isVisualTest: true,
});

/**
 * Pure, fail-closed parser for the compile-time frontend signal.
 *
 * - `undefined` / `null` (absent)               -> ordinary production
 * - exact `monochrome-visual-test`              -> visual-test mode
 * - every other value, including `''`            -> throws (before React boot)
 */
export function parseRuntimeProfile(raw: string | undefined | null): RuntimeProfile {
  if (raw === undefined || raw === null) {
    return ORDINARY_PROFILE;
  }
  if (raw === MONOCHROME_VISUAL_TEST) {
    return VISUAL_TEST_PROFILE;
  }
  throw new Error(`Invalid ${RUNTIME_PROFILE_ENV} runtime profile.`);
}

/** Derive the full effect-host suppression plan from a resolved profile. */
export function runtimePlan(profile: RuntimeProfile): RuntimePlan {
  const enabled = profile.isOrdinary;
  return Object.freeze({
    profile,
    isOrdinary: profile.isOrdinary,
    isVisualTest: profile.isVisualTest,
    vaultKeychainHydrationEnabled: enabled,
    terminalLauncherInstallEnabled: enabled,
    cloudSyncEnabled: enabled,
    updateChecksEnabled: enabled,
    nativeNotificationsEnabled: enabled,
    backgroundServicesEnabled: enabled,
    persistenceEnabled: enabled,
    agentRuntimeEnabled: enabled,
    kernelEnabled: enabled,
    lifecycleEnabled: enabled,
    globalHotkeyEnabled: enabled,
    idleEnabled: enabled,
    analyticsEnabled: enabled,
    wakeWordEnabled: enabled,
    petEnabled: enabled,
    sttEnabled: enabled,
    terminalCliEnabled: enabled,
    devConsoleEnabled: enabled,
    updateEffectsEnabled: enabled,
  });
}

/**
 * Read the compile-time frontend signal. Direct member access lets Vite
 * statically replace the value in production builds; the cast keeps this
 * independent of a project-specific `ImportMetaEnv` field declaration.
 */
function readCompileTimeSignal(): string | undefined {
  return import.meta.env.VITE_VIBESPACE_RUNTIME_PROFILE as string | undefined;
}

/** Resolve the frontend profile, defaulting to the compile-time signal. */
export function resolveRuntimeProfile(
  raw: string | undefined | null = readCompileTimeSignal(),
): RuntimeProfile {
  return parseRuntimeProfile(raw);
}

/** Resolve the full suppression plan, defaulting to the compile-time signal. */
export function resolveRuntimePlan(
  raw: string | undefined | null = readCompileTimeSignal(),
): RuntimePlan {
  return runtimePlan(parseRuntimeProfile(raw));
}

// ---------------------------------------------------------------------------
// Product-owned visual fixture request
// ---------------------------------------------------------------------------

const MONOCHROME_FIXTURE_QUERY_KEYS = [
  'monochrome-fixture',
  'monochrome-fixture-hash',
  'monochrome-surface',
  'monochrome-theme',
  'monochrome-origami-gate',
  'monochrome-state',
] as const;
const MONOCHROME_BROWSER_LOCATION_QUERY_KEYS = [
  'view',
  'workbench',
  'monochrome-workbench',
  'tab',
] as const;
const MONOCHROME_SURFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const MONOCHROME_REQUEST_THEMES = new Set([
  'monochrome',
  'default',
  'vibespace',
  'jarvis',
  'origami',
]);
const MONOCHROME_ROUTE_IDS = new Set([
  'chat',
  'canvas',
  'workbench',
  'preview',
  'browser',
  'terminal',
  'kanban',
  'schedule',
  'agents',
  'agent-detail',
  'project-detail',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'account',
]);
const MONOCHROME_STATE_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;
export interface MonochromeFixtureRequest {
  readonly fixtureId: string;
  readonly fixtureHash: string;
  readonly surfaceId: string;
  readonly requestedTheme: 'monochrome' | 'default' | 'vibespace' | 'jarvis' | 'origami';
  readonly productTheme: 'monochrome' | 'default' | 'vibespace' | 'jarvis';
  readonly origamiGate: boolean;
  readonly requestedRoute: string;
  readonly requestedState?: string;
  readonly authorityId?: string;
  readonly settingsTab?: string;
}

function invalidFixtureRequest(): never {
  throw new Error('MonoChrome fixture request invalid.');
}

export interface MonochromeBrowserRequestAuthorityEntry {
  readonly fixtureHash: string;
  readonly fixtureId: 'chat' | 'settings-appearance' | 'terminal-workbench';
  readonly id: string;
  readonly kind: string;
  readonly routeId: string | null;
}

export interface MonochromeExactRequestAuthorityEntry {
  readonly caseId?: string;
  readonly fixtureHash: string;
  readonly fixtureId: 'chat' | 'settings-appearance' | 'terminal-workbench';
  readonly locationQuery?: Readonly<Record<string, string>>;
  readonly origamiGate: boolean;
  readonly pathname: string;
  readonly productTheme: 'monochrome' | 'default' | 'vibespace' | 'jarvis';
  readonly requestedRoute: string;
  readonly requestedState?: string;
  readonly requestedTheme: 'monochrome' | 'default' | 'vibespace' | 'jarvis' | 'origami';
  readonly settingsTab?: string;
  readonly surfaceId: string;
}

const MONOCHROME_BROWSER_CASE_IDS = Object.freeze([
  'access:app-host',
  'access:banner',
  'access:locked',
  'detached:dictation',
  'detached:pet-mini-panel',
  'detached:pet-overlay',
  'detached:workbench-main',
  MONOCHROME_DEVELOPMENT_AUTHORITY_ID,
  'embedded:browser-operator',
  'embedded:command-center',
  'embedded:prompt-forge',
  'overlay:actions-palette-host',
  'overlay:activity-strip',
  'overlay:ambient-home',
  'overlay:api-key-save-burst',
  'overlay:app-dispatch',
  'overlay:app-shell',
  'overlay:assistant-bar-host',
  'overlay:call-modal',
  'overlay:celebration-host',
  'overlay:command-palette-host',
  'overlay:file-explorer-host',
  'overlay:global-dictation-overlay',
  'overlay:inspector',
  'overlay:jarvis-context-menu',
  'overlay:launcher-dialog-host',
  'overlay:nav-pane',
  'overlay:news-host',
  'overlay:page-router',
  'overlay:pet-host',
  'overlay:pet-mini-panel-window',
  'overlay:pet-overlay-window',
  'overlay:product-tutorial-host',
  'overlay:settings-modal-host',
  'overlay:tab-strip',
  'overlay:toaster',
  'overlay:top-bar',
  'overlay:update-warning-host',
  'overlay:voice-modal-host',
  'overlay:wellness-break',
  'overlay:whats-new-host',
  'overlay:workbench-window-dispatch',
  'route:account',
  'route:agent-detail',
  'route:agents',
  'route:benchmarks',
  'route:browser',
  'route:canvas',
  'route:chat',
  'route:context',
  'route:files',
  'route:history',
  'route:kanban',
  'route:preview',
  'route:project-detail',
  'route:schedule',
  'route:skills',
  'route:terminal',
  'route:tools',
  'route:workbench',
  'settings:about',
  'settings:accessibility',
  'settings:admin',
  'settings:allaboutme',
  'settings:ambient',
  'settings:appearance',
  'settings:composerstt',
  'settings:connections',
  'settings:hive',
  'settings:hotkeys',
  'settings:jarvisactions',
  'settings:localmodels',
  'settings:notifications',
  'settings:phone',
  'settings:plans',
  'settings:plugins',
  'settings:providers',
  'settings:voice',
] as const);

const TERMINAL_FIXTURE_CASE_IDS = new Set<string>([
  'detached:workbench-main',
  'development:monochrome-workbench',
  'overlay:workbench-window-dispatch',
  'route:context',
  'route:files',
  'route:terminal',
  'route:workbench',
]);

function fixtureForBrowserCase(id: string): MonochromeBrowserRequestAuthorityEntry['fixtureId'] {
  if (
    id.startsWith('settings:') ||
    id.startsWith('access:') ||
    id === 'overlay:settings-modal-host' ||
    id === 'route:account'
  ) {
    return 'settings-appearance';
  }
  return TERMINAL_FIXTURE_CASE_IDS.has(id) ? 'terminal-workbench' : 'chat';
}

/**
 * Product-side copy of the complete browser projection. Keeping all five
 * authority fields makes fixture admission reject tuple drift instead of
 * treating a matching suffix as sufficient authority.
 */
export const MONOCHROME_BROWSER_REQUEST_AUTHORITY = Object.freeze(
  MONOCHROME_BROWSER_CASE_IDS.map((id) => {
    const fixtureId = fixtureForBrowserCase(id);
    const [kind, suffix] = id.split(':', 2);
    return Object.freeze({
      fixtureHash: MONOCHROME_PRIMITIVE_MANIFEST.fixtureHashes[fixtureId],
      fixtureId,
      id,
      kind,
      routeId: kind === 'route' ? suffix : null,
    });
  }) as readonly MonochromeBrowserRequestAuthorityEntry[],
);

const CHAT_FIXTURE_HASH = 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9';
const SETTINGS_FIXTURE_HASH = '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875';
const TERMINAL_FIXTURE_HASH = 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b';

export const MONOCHROME_BASELINE_REQUEST_AUTHORITY = Object.freeze([
  Object.freeze({
    caseId: 'default-chat',
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'default',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'default',
    surfaceId: 'baseline:default-chat',
  }),
  Object.freeze({
    caseId: 'default-settings',
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'default',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'default',
    settingsTab: 'appearance',
    surfaceId: 'baseline:default-settings',
  }),
  Object.freeze({
    caseId: 'default-terminal',
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'default',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'default',
    surfaceId: 'baseline:default-terminal',
  }),
  Object.freeze({
    caseId: 'jarvis-chat',
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'jarvis',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'jarvis',
    surfaceId: 'baseline:jarvis-chat',
  }),
  Object.freeze({
    caseId: 'jarvis-settings',
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'jarvis',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'jarvis',
    settingsTab: 'appearance',
    surfaceId: 'baseline:jarvis-settings',
  }),
  Object.freeze({
    caseId: 'jarvis-terminal',
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'jarvis',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'jarvis',
    surfaceId: 'baseline:jarvis-terminal',
  }),
  Object.freeze({
    caseId: 'origami-chat',
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: true,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'origami',
    surfaceId: 'baseline:origami-chat',
  }),
  Object.freeze({
    caseId: 'vibespace-chat',
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: true,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'vibespace',
    surfaceId: 'baseline:vibespace-chat',
  }),
  Object.freeze({
    caseId: 'vibespace-settings',
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'vibespace',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'vibespace',
    settingsTab: 'appearance',
    surfaceId: 'baseline:vibespace-settings',
  }),
  Object.freeze({
    caseId: 'vibespace-terminal',
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'vibespace',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'vibespace',
    surfaceId: 'baseline:vibespace-terminal',
  }),
] as const satisfies readonly MonochromeExactRequestAuthorityEntry[]);

export const MONOCHROME_LEGACY_REQUEST_AUTHORITY = Object.freeze([
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:text-contrast',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:non-text-contrast',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:pointer-targets',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:forced-colors',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:production-navigation',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/canvas',
    productTheme: 'monochrome',
    requestedRoute: 'canvas',
    requestedTheme: 'monochrome',
    surfaceId: 'spatial:canvas',
  }),
  Object.freeze({
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/context',
    productTheme: 'monochrome',
    requestedRoute: 'context',
    requestedTheme: 'monochrome',
    surfaceId: 'spatial:context',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'default',
    requestedRoute: 'chat',
    requestedTheme: 'default',
    surfaceId: 'theme:default',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'jarvis',
    requestedRoute: 'chat',
    requestedTheme: 'jarvis',
    surfaceId: 'theme:jarvis',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'theme:monochrome',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: true,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedTheme: 'origami',
    surfaceId: 'theme:origami',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedTheme: 'vibespace',
    surfaceId: 'theme:vibespace',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:50%',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:80%',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:100%',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:125%',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:150%',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'zoom:200%',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    locationQuery: Object.freeze({ tab: 'usage' }),
    origamiGate: false,
    pathname: '/account',
    productTheme: 'monochrome',
    requestedRoute: 'account',
    requestedState: 'usage',
    requestedTheme: 'monochrome',
    surfaceId: 'state:usage',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/settings/plans',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'billing',
    requestedTheme: 'monochrome',
    settingsTab: 'plans',
    surfaceId: 'state:billing-plans',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'dropdown-open',
    requestedTheme: 'monochrome',
    surfaceId: 'state:dropdown-open',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
    requestedTheme: 'monochrome',
    surfaceId: 'state:tooltip-visible',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'empty',
    requestedTheme: 'monochrome',
    surfaceId: 'state:empty-state',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'modal-open',
    requestedTheme: 'monochrome',
    surfaceId: 'state:modal-open',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedState: 'toast-visible',
    requestedTheme: 'monochrome',
    surfaceId: 'state:toast-visible',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/account',
    productTheme: 'monochrome',
    requestedRoute: 'account',
    requestedState: 'locked',
    requestedTheme: 'monochrome',
    surfaceId: 'state:locked-access',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'default',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'default',
    settingsTab: 'appearance',
    surfaceId: 'state:modal-open-default',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'jarvis',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'jarvis',
    settingsTab: 'appearance',
    surfaceId: 'state:modal-open-jarvis',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'monochrome',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'monochrome',
    settingsTab: 'appearance',
    surfaceId: 'state:modal-open-monochrome',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'vibespace',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'vibespace',
    settingsTab: 'appearance',
    surfaceId: 'state:modal-open-vibespace',
  }),
  Object.freeze({
    fixtureHash: SETTINGS_FIXTURE_HASH,
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/account',
    productTheme: 'monochrome',
    requestedRoute: 'account',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:account',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/agent-detail',
    productTheme: 'monochrome',
    requestedRoute: 'agent-detail',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:agent-detail',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/agents',
    productTheme: 'monochrome',
    requestedRoute: 'agents',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:agents',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/benchmarks',
    productTheme: 'monochrome',
    requestedRoute: 'benchmarks',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:benchmarks',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/browser',
    productTheme: 'monochrome',
    requestedRoute: 'browser',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:browser',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/canvas',
    productTheme: 'monochrome',
    requestedRoute: 'canvas',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:canvas',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'monochrome',
    requestedRoute: 'chat',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:chat',
  }),
  Object.freeze({
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/context',
    productTheme: 'monochrome',
    requestedRoute: 'context',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:context',
  }),
  Object.freeze({
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/files',
    productTheme: 'monochrome',
    requestedRoute: 'files',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:files',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/history',
    productTheme: 'monochrome',
    requestedRoute: 'history',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:history',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/kanban',
    productTheme: 'monochrome',
    requestedRoute: 'kanban',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:kanban',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/preview',
    productTheme: 'monochrome',
    requestedRoute: 'preview',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:preview',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/project-detail',
    productTheme: 'monochrome',
    requestedRoute: 'project-detail',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:project-detail',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/schedule',
    productTheme: 'monochrome',
    requestedRoute: 'schedule',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:schedule',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/skills',
    productTheme: 'monochrome',
    requestedRoute: 'skills',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:skills',
  }),
  Object.freeze({
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'monochrome',
    requestedRoute: 'terminal',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:terminal',
  }),
  Object.freeze({
    fixtureHash: CHAT_FIXTURE_HASH,
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/tools',
    productTheme: 'monochrome',
    requestedRoute: 'tools',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:tools',
  }),
  Object.freeze({
    fixtureHash: TERMINAL_FIXTURE_HASH,
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/workbench',
    productTheme: 'monochrome',
    requestedRoute: 'workbench',
    requestedTheme: 'monochrome',
    surfaceId: 'a11y:route:workbench',
  }),
] as const satisfies readonly MonochromeExactRequestAuthorityEntry[]);

function browserPathForAuthority(entry: MonochromeBrowserRequestAuthorityEntry): string {
  if (entry.kind === 'route') return `/${entry.routeId}`;
  if (entry.kind === 'settings') return `/settings/${entry.id.slice('settings:'.length)}`;
  if (entry.kind === 'detached') {
    const query: Readonly<Record<string, string>> = {
      'detached:dictation': '?view=dictation',
      'detached:pet-mini-panel': '?view=pet-mini-panel',
      'detached:pet-overlay': '?view=pet-overlay',
      'detached:workbench-main': '?workbench=1',
    };
    return `/${query[entry.id] ?? ''}`;
  }
  if (entry.id === 'development:monochrome-workbench') return '/?monochrome-workbench=1';
  if (entry.id === 'embedded:browser-operator') return '/browser?monochrome-state=operator';
  if (entry.id === 'embedded:command-center') return '/chat?monochrome-state=command-center';
  if (entry.id === 'embedded:prompt-forge') return '/chat?monochrome-state=prompt-forge';
  if (entry.id === 'access:locked') return '/account?monochrome-state=locked';
  if (entry.id.startsWith('access:')) return '/account';
  if (entry.id === 'overlay:settings-modal-host') return '/chat?monochrome-state=settings-modal';
  return `/chat?monochrome-state=${encodeURIComponent(entry.id)}`;
}

function matchesAuthorityLocation(
  entry: MonochromeBrowserRequestAuthorityEntry,
  query: URLSearchParams,
  pathname: string,
): boolean {
  const expected = new URL(browserPathForAuthority(entry), 'http://monochrome.invalid');
  if (pathname !== expected.pathname) return false;
  const allowedKeys = new Set<string>([
    ...MONOCHROME_FIXTURE_QUERY_KEYS,
    ...expected.searchParams.keys(),
  ]);
  if ([...query.keys()].some((key) => !allowedKeys.has(key))) return false;
  for (const key of [...MONOCHROME_BROWSER_LOCATION_QUERY_KEYS, 'monochrome-state'] as const) {
    const actualValues = query.getAll(key);
    const expectedValues = expected.searchParams.getAll(key);
    if (
      actualValues.length !== expectedValues.length ||
      actualValues.some((value, index) => value !== expectedValues[index])
    ) {
      return false;
    }
  }
  return true;
}

function hasOnlyExactAuthorityQueryKeys(
  entry: MonochromeExactRequestAuthorityEntry,
  query: URLSearchParams,
): boolean {
  const allowedKeys = new Set<string>([
    ...(entry.requestedState === undefined
      ? MONOCHROME_FIXTURE_QUERY_KEYS.slice(0, 5)
      : MONOCHROME_FIXTURE_QUERY_KEYS),
    ...Object.keys(entry.locationQuery ?? {}),
  ]);
  return (
    [...query.keys()].every((key) => allowedKeys.has(key)) &&
    Object.entries(entry.locationQuery ?? {}).every(([key, expectedValue]) => {
      const actualValues = query.getAll(key);
      return actualValues.length === 1 && actualValues[0] === expectedValue;
    })
  );
}

export function parseMonochromeFixtureRequest(
  plan: RuntimePlan,
  query: URLSearchParams,
  pathname = '/',
): MonochromeFixtureRequest | undefined {
  const suppliedKeys = [...query.keys()];
  const hasTestParameter = suppliedKeys.some((key) => key.startsWith('monochrome-'));
  if (plan.isOrdinary) {
    if (hasTestParameter) {
      throw new Error('MonoChrome fixture parameters are forbidden in the ordinary runtime.');
    }
    return undefined;
  }
  if (
    suppliedKeys.some(
      (key) =>
        key.startsWith('monochrome-') &&
        !(MONOCHROME_FIXTURE_QUERY_KEYS as readonly string[]).includes(key) &&
        !(MONOCHROME_BROWSER_LOCATION_QUERY_KEYS as readonly string[]).includes(key),
    ) ||
    MONOCHROME_FIXTURE_QUERY_KEYS.slice(0, 5).some((key) => query.getAll(key).length !== 1) ||
    query.getAll('monochrome-state').length > 1
  ) {
    return invalidFixtureRequest();
  }

  const fixtureId = query.get('monochrome-fixture');
  const fixtureHash = query.get('monochrome-fixture-hash');
  const surfaceId = query.get('monochrome-surface');
  const requestedTheme = query.get('monochrome-theme');
  const origamiGateRaw = query.get('monochrome-origami-gate');
  const requestedState = query.get('monochrome-state') ?? undefined;
  const routeSegment = pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'chat';
  const requestedRoute =
    routeSegment === 'agent'
      ? 'agent-detail'
      : routeSegment === 'project'
        ? 'project-detail'
        : routeSegment;
  const authority = MONOCHROME_BROWSER_REQUEST_AUTHORITY.find((entry) => entry.id === surfaceId);
  const exactAuthority: MonochromeExactRequestAuthorityEntry | undefined =
    MONOCHROME_BASELINE_REQUEST_AUTHORITY.find((entry) => entry.surfaceId === surfaceId) ??
    MONOCHROME_LEGACY_REQUEST_AUTHORITY.find((entry) => entry.surfaceId === surfaceId);
  if (
    !fixtureId ||
    !MONOCHROME_PRIMITIVE_MANIFEST.fixtureIds.includes(fixtureId) ||
    !fixtureHash ||
    MONOCHROME_PRIMITIVE_MANIFEST.fixtureHashes[fixtureId] !== fixtureHash ||
    !surfaceId ||
    (!exactAuthority && !MONOCHROME_SURFACE_PATTERN.test(surfaceId)) ||
    !requestedTheme ||
    !MONOCHROME_REQUEST_THEMES.has(requestedTheme) ||
    (origamiGateRaw !== 'true' && origamiGateRaw !== 'false') ||
    (!authority && !exactAuthority && !MONOCHROME_ROUTE_IDS.has(requestedRoute)) ||
    (requestedState !== undefined && !MONOCHROME_STATE_PATTERN.test(requestedState)) ||
    (!authority &&
      !exactAuthority &&
      fixtureId === 'settings-appearance' &&
      requestedState === undefined)
  ) {
    return invalidFixtureRequest();
  }
  const origamiGate = origamiGateRaw === 'true';
  const productTheme = requestedTheme === 'origami' ? 'vibespace' : requestedTheme;
  if (exactAuthority) {
    if (
      !hasOnlyExactAuthorityQueryKeys(exactAuthority, query) ||
      fixtureId !== exactAuthority.fixtureId ||
      fixtureHash !== exactAuthority.fixtureHash ||
      pathname !== exactAuthority.pathname ||
      requestedState !== exactAuthority.requestedState ||
      requestedTheme !== exactAuthority.requestedTheme ||
      productTheme !== exactAuthority.productTheme ||
      origamiGate !== exactAuthority.origamiGate
    ) {
      return invalidFixtureRequest();
    }
    return Object.freeze({
      authorityId: exactAuthority.surfaceId,
      fixtureHash: exactAuthority.fixtureHash,
      fixtureId: exactAuthority.fixtureId,
      origamiGate: exactAuthority.origamiGate,
      productTheme: exactAuthority.productTheme,
      requestedRoute: exactAuthority.requestedRoute,
      ...(exactAuthority.requestedState === undefined
        ? {}
        : { requestedState: exactAuthority.requestedState }),
      requestedTheme: exactAuthority.requestedTheme,
      ...(exactAuthority.settingsTab === undefined
        ? {}
        : { settingsTab: exactAuthority.settingsTab }),
      surfaceId: exactAuthority.surfaceId,
    });
  }
  if (origamiGate !== (requestedTheme === 'origami')) {
    return invalidFixtureRequest();
  }
  if (authority) {
    if (
      fixtureId !== authority.fixtureId ||
      fixtureHash !== authority.fixtureHash ||
      !matchesAuthorityLocation(authority, query, pathname)
    ) {
      return invalidFixtureRequest();
    }
    const authorityRoute =
      authority.kind === 'route'
        ? authority.routeId!
        : authority.id === 'embedded:browser-operator'
          ? 'browser'
          : authority.kind === 'access'
            ? 'account'
            : authority.id === 'detached:workbench-main'
              ? 'workbench'
              : 'chat';
    return Object.freeze({
      fixtureId,
      fixtureHash,
      surfaceId,
      requestedTheme,
      productTheme,
      origamiGate,
      requestedRoute: authorityRoute,
      authorityId: authority.id,
      ...(requestedState === undefined ? {} : { requestedState }),
      ...(authority.kind === 'settings'
        ? { settingsTab: authority.id.slice('settings:'.length) }
        : {}),
    }) as MonochromeFixtureRequest;
  }
  return invalidFixtureRequest();
}

// ---------------------------------------------------------------------------
// Frontend/native handshake
// ---------------------------------------------------------------------------

export interface RuntimeProfileHandshakeExpectation {
  readonly appIdentifier: string;
  readonly capabilityIdentifier: 'monochrome-test';
  readonly sessionNonceHash: string;
}

export interface RuntimeProfileHandshakeExpectationInput {
  readonly appIdentifier: string | undefined;
  readonly capabilityIdentifier: string | undefined;
  readonly sessionNonceHash: string | undefined;
}

const MONOCHROME_APP_IDENTIFIER_PATTERN = /^ai\.vibespace\.monochrome\.test[0-9A-Fa-f]+$/;
const SESSION_NONCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parse the three test-only compile-time identity expectations. Ordinary mode
 * needs none of them. Visual-test mode requires all three exact values before
 * the native query is attempted.
 */
export function parseRuntimeProfileHandshakeExpectation(
  plan: RuntimePlan,
  raw: RuntimeProfileHandshakeExpectationInput,
): RuntimeProfileHandshakeExpectation | undefined {
  if (plan.isOrdinary) {
    if (
      raw.appIdentifier !== undefined ||
      raw.capabilityIdentifier !== undefined ||
      raw.sessionNonceHash !== undefined
    ) {
      throw new Error(
        'Test-only runtime identity signals must be absent for the ordinary runtime profile.',
      );
    }
    return undefined;
  }
  if (!raw.appIdentifier || !MONOCHROME_APP_IDENTIFIER_PATTERN.test(raw.appIdentifier)) {
    throw new Error(
      `Invalid ${MONOCHROME_APP_IDENTIFIER_ENV}; expected ai.vibespace.monochrome.test<hex>.`,
    );
  }
  if (raw.capabilityIdentifier !== 'monochrome-test') {
    throw new Error(
      `Invalid ${MONOCHROME_CAPABILITY_IDENTIFIER_ENV}; expected exact "monochrome-test".`,
    );
  }
  if (!raw.sessionNonceHash || !SESSION_NONCE_HASH_PATTERN.test(raw.sessionNonceHash)) {
    throw new Error(
      `Invalid ${MONOCHROME_SESSION_NONCE_HASH_ENV}; expected a lowercase 64-hex hash.`,
    );
  }
  return Object.freeze({
    appIdentifier: raw.appIdentifier,
    capabilityIdentifier: raw.capabilityIdentifier,
    sessionNonceHash: raw.sessionNonceHash,
  });
}

function readCompileTimeHandshakeExpectation(): RuntimeProfileHandshakeExpectationInput {
  return {
    appIdentifier: import.meta.env.VITE_VIBESPACE_MONOCHROME_APP_IDENTIFIER as string | undefined,
    capabilityIdentifier: import.meta.env.VITE_VIBESPACE_MONOCHROME_CAPABILITY_IDENTIFIER as
      | string
      | undefined,
    sessionNonceHash: import.meta.env.VITE_VIBESPACE_MONOCHROME_SESSION_NONCE_HASH as
      | string
      | undefined,
  };
}

export function resolveRuntimeProfileHandshakeExpectation(
  plan: RuntimePlan,
  raw: RuntimeProfileHandshakeExpectationInput = readCompileTimeHandshakeExpectation(),
): RuntimeProfileHandshakeExpectation | undefined {
  return parseRuntimeProfileHandshakeExpectation(plan, raw);
}

export interface RuntimeProfileEvidence {
  readonly profile: string;
  readonly appIdentifier: string;
  readonly capabilityIdentifier: string | null;
  readonly sessionNonceHash: string | null;
  readonly deniedEffects?: MonochromeDeniedEffectSnapshot;
}

export interface MonochromeHandshakeEvidence {
  readonly profile: string;
  readonly appIdentifier: string;
  readonly capabilityIdentifier: string | null;
  readonly sessionNonceHash: string | null;
}

export interface MonochromeEvidenceReadiness {
  readonly status: 'PASS';
  readonly application: 'READY';
  readonly fixtureSmoke: 'PASS';
  readonly surface: 'route:chat';
  readonly theme: 'monochrome';
  readonly font: 'READY';
  readonly fallback: 'NOT_USED';
}

export interface MonochromeDeniedEffectCounters {
  readonly notification: number;
  readonly processRelaunch: number;
  readonly updater: number;
  readonly shellOpen: number;
  readonly externalHttp: number;
  readonly keychain: number;
  readonly registry: number;
  readonly launcher: number;
  readonly tray: number;
  readonly singleInstance: number;
  readonly globalShortcut: number;
  readonly deepLink: number;
  readonly autostart: number;
}

export interface MonochromeDeniedEffectSnapshot {
  readonly status: 'PASS' | 'FAIL';
  readonly manifestHash: typeof MONOCHROME_DENIED_EFFECT_MANIFEST_HASH;
  readonly counters: MonochromeDeniedEffectCounters;
}

export interface MonochromeEvidenceCommitRequest {
  readonly nativeHandshake: MonochromeHandshakeEvidence;
  readonly frontendHandshake: MonochromeHandshakeEvidence;
  readonly readiness: MonochromeEvidenceReadiness;
  readonly errors: {
    readonly page: readonly [];
    readonly native: readonly [];
  };
}

export interface MonochromeEvidenceCommitResult {
  readonly status: 'COMMITTED';
  readonly schemaVersion: typeof MONOCHROME_EVIDENCE_SCHEMA_VERSION;
  readonly sessionNonceHash: string;
  readonly producer: {
    readonly pid: number;
    readonly creationTimeUtc: string;
    readonly creationTimeHash: string;
    readonly executableHash: string;
    readonly commandHash: string;
  };
}

export type MonochromeEvidenceCommit = (
  request: MonochromeEvidenceCommitRequest,
) => Promise<MonochromeEvidenceCommitResult>;

export type RuntimeProfileQueryCommand = typeof RUNTIME_PROFILE_QUERY_COMMAND;

export type RuntimeProfileQuery = (
  command: RuntimeProfileQueryCommand,
) => Promise<RuntimeProfileEvidence>;

const ORDINARY_EVIDENCE_KEYS = [
  'profile',
  'appIdentifier',
  'capabilityIdentifier',
  'sessionNonceHash',
] as const;
const VISUAL_EVIDENCE_KEYS = [...ORDINARY_EVIDENCE_KEYS, 'deniedEffects'] as const;
const DENIED_EFFECT_KEYS = ['status', 'manifestHash', 'counters'] as const;
const DENIED_EFFECT_COUNTER_KEYS = [
  'notification',
  'processRelaunch',
  'updater',
  'shellOpen',
  'externalHttp',
  'keychain',
  'registry',
  'launcher',
  'tray',
  'singleInstance',
  'globalShortcut',
  'deepLink',
  'autostart',
] as const;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactOrderedKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

function invalidNativeEvidence(): never {
  throw new Error('Runtime profile query failed: native evidence invalid');
}

function parseRuntimeProfileEvidence(raw: unknown): RuntimeProfileEvidence {
  if (!isUnknownRecord(raw) || typeof raw.profile !== 'string') {
    return invalidNativeEvidence();
  }
  if (raw.profile === 'ordinary') {
    if (
      !hasExactOrderedKeys(raw, ORDINARY_EVIDENCE_KEYS) ||
      raw.appIdentifier !== 'ai.jarvis.desktop' ||
      raw.capabilityIdentifier !== null ||
      raw.sessionNonceHash !== null
    ) {
      return invalidNativeEvidence();
    }
    return raw as unknown as RuntimeProfileEvidence;
  }
  if (
    raw.profile !== MONOCHROME_VISUAL_TEST ||
    !hasExactOrderedKeys(raw, VISUAL_EVIDENCE_KEYS) ||
    typeof raw.appIdentifier !== 'string' ||
    !MONOCHROME_APP_IDENTIFIER_PATTERN.test(raw.appIdentifier) ||
    raw.capabilityIdentifier !== 'monochrome-test' ||
    typeof raw.sessionNonceHash !== 'string' ||
    !SESSION_NONCE_HASH_PATTERN.test(raw.sessionNonceHash)
  ) {
    return invalidNativeEvidence();
  }
  const deniedEffects = raw.deniedEffects;
  if (
    !isUnknownRecord(deniedEffects) ||
    !hasExactOrderedKeys(deniedEffects, DENIED_EFFECT_KEYS) ||
    (deniedEffects.status !== 'PASS' && deniedEffects.status !== 'FAIL') ||
    deniedEffects.manifestHash !== MONOCHROME_DENIED_EFFECT_MANIFEST_HASH
  ) {
    return invalidNativeEvidence();
  }
  const counters = deniedEffects.counters;
  if (
    !isUnknownRecord(counters) ||
    !hasExactOrderedKeys(counters, DENIED_EFFECT_COUNTER_KEYS) ||
    DENIED_EFFECT_COUNTER_KEYS.some(
      (key) => !Number.isSafeInteger(counters[key]) || (counters[key] as number) < 0,
    )
  ) {
    return invalidNativeEvidence();
  }
  return raw as unknown as RuntimeProfileEvidence;
}

/**
 * Prove the frontend and native boundaries agree before any fixture interaction.
 * Fails closed when the query is unavailable, the evidence is missing/malformed,
 * or the native profile disagrees with the resolved frontend profile.
 */
export async function verifyRuntimeProfileHandshake(
  query: RuntimeProfileQuery,
  plan: RuntimePlan = resolveRuntimePlan(),
  expectation?: RuntimeProfileHandshakeExpectation,
  timeoutMs: number = RUNTIME_PROFILE_QUERY_TIMEOUT_MS,
): Promise<RuntimeProfileEvidence> {
  if (plan.isVisualTest && !expectation) {
    throw new Error('Runtime profile handshake failed: visual-test identity expectation missing');
  }
  let evidence: RuntimeProfileEvidence | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    evidence = await Promise.race([
      query(RUNTIME_PROFILE_QUERY_COMMAND),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Runtime profile handshake failed: native query timed out')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('native query timed out')) {
      throw error;
    }
    throw new Error('Runtime profile handshake failed: native query unavailable');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (!evidence || typeof evidence.profile !== 'string' || evidence.profile.length === 0) {
    throw new Error('Runtime profile handshake failed: native profile evidence missing');
  }
  if (evidence.profile !== plan.profile.kind) {
    throw new Error('Runtime profile handshake failed: frontend/native profile mismatch');
  }
  if (
    plan.isOrdinary &&
    (evidence.appIdentifier !== 'ai.jarvis.desktop' ||
      evidence.capabilityIdentifier !== null ||
      evidence.sessionNonceHash !== null)
  ) {
    throw new Error('Runtime profile handshake failed: ordinary identity invalid');
  }
  if (
    expectation &&
    (evidence.appIdentifier !== expectation.appIdentifier ||
      evidence.capabilityIdentifier !== expectation.capabilityIdentifier ||
      evidence.sessionNonceHash !== expectation.sessionNonceHash)
  ) {
    throw new Error(
      'Runtime profile handshake failed: native session/config identity does not match frontend expectations',
    );
  }
  return parseRuntimeProfileEvidence(evidence);
}

/**
 * Build a narrow typed adapter over a Tauri `invoke`. The invoke function is
 * injectable so tests never touch the native bridge; production callers may omit
 * it to lazily import `@tauri-apps/api/core`.
 */
export function createTauriRuntimeProfileQuery(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = defaultInvoke,
): RuntimeProfileQuery {
  return async (command) => {
    const result = await invoke(command);
    return parseRuntimeProfileEvidence(result);
  };
}

/**
 * Direct Tauri adapter for the native evidence ledger. The four request fields
 * are passed as the command arguments themselves; capability token and ledger
 * path remain exclusively inside the native command.
 */
export function createTauriMonochromeEvidenceCommit(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = defaultInvoke,
): MonochromeEvidenceCommit {
  return async (request) => {
    const commandArguments = {
      nativeHandshake: request.nativeHandshake,
      frontendHandshake: request.frontendHandshake,
      readiness: request.readiness,
      errors: request.errors,
    };
    const result = await invoke(MONOCHROME_EVIDENCE_COMMIT_COMMAND, commandArguments);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('MonoChrome evidence commit failed: native result invalid');
    }
    const record = result as Record<string, unknown>;
    const exactKeys = ['producer', 'schemaVersion', 'sessionNonceHash', 'status'];
    const producer =
      record.producer && typeof record.producer === 'object' && !Array.isArray(record.producer)
        ? (record.producer as Record<string, unknown>)
        : undefined;
    const producerKeys = [
      'commandHash',
      'creationTimeHash',
      'creationTimeUtc',
      'executableHash',
      'pid',
    ];
    const hashPattern = /^[0-9a-f]{64}$/;
    const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
    if (
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(exactKeys) ||
      record.status !== 'COMMITTED' ||
      record.schemaVersion !== MONOCHROME_EVIDENCE_SCHEMA_VERSION ||
      record.sessionNonceHash !== request.frontendHandshake.sessionNonceHash ||
      !producer ||
      JSON.stringify(Object.keys(producer).sort()) !== JSON.stringify(producerKeys) ||
      !Number.isSafeInteger(producer.pid) ||
      (producer.pid as number) <= 0 ||
      typeof producer.creationTimeUtc !== 'string' ||
      !utcPattern.test(producer.creationTimeUtc) ||
      Number.isNaN(Date.parse(producer.creationTimeUtc)) ||
      typeof producer.creationTimeHash !== 'string' ||
      !hashPattern.test(producer.creationTimeHash) ||
      typeof producer.executableHash !== 'string' ||
      !hashPattern.test(producer.executableHash) ||
      typeof producer.commandHash !== 'string' ||
      !hashPattern.test(producer.commandHash)
    ) {
      throw new Error('MonoChrome evidence commit failed: native result invalid');
    }
    return record as unknown as MonochromeEvidenceCommitResult;
  };
}

async function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}
