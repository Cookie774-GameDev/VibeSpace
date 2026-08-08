import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error TS5097 -- Direct Node test execution requires the explicit .ts extension.
import { MONOCHROME_FIXTURE_MANIFEST, MONOCHROME_SOURCE_COMMIT } from './fixture-manifest.ts';
// @ts-expect-error TS5097 -- Direct Node test execution requires the explicit .ts extension.
import { MONOCHROME_NATIVE_WINDOW_MANIFEST } from './native-window-manifest.ts';
// @ts-expect-error TS5097 -- Direct Node test execution requires the explicit .ts extension.
import { MONOCHROME_SHELL_OVERLAY_MANIFEST } from './shell-overlay-manifest.ts';

export const MONOCHROME_FINAL_ROUTE_IDS = Object.freeze([
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
] as const);

export type MonochromeRouteId = (typeof MONOCHROME_FINAL_ROUTE_IDS)[number];

export const MONOCHROME_SETTINGS_TAB_IDS = Object.freeze([
  'plans',
  'providers',
  'connections',
  'hive',
  'allaboutme',
  'plugins',
  'localmodels',
  'appearance',
  'voice',
  'composerstt',
  'phone',
  'ambient',
  'notifications',
  'accessibility',
  'hotkeys',
  'jarvisactions',
  'admin',
  'about',
] as const);

export type MonochromeSettingsTabId = (typeof MONOCHROME_SETTINGS_TAB_IDS)[number];
export type MonochromeFixtureId = 'chat' | 'settings-appearance' | 'terminal-workbench';
export type MonochromeCoverageKind =
  | 'route'
  | 'settings'
  | 'access'
  | 'overlay'
  | 'detached'
  | 'native'
  | 'embedded'
  | 'development'
  | 'future';
export type MonochromeAuditStatus = 'covered' | 'development-only' | 'native-only' | 'unavailable';
export type MonochromeSurfaceAvailability =
  | 'production'
  | 'feature-flagged'
  | 'development-only'
  | 'native-only'
  | 'unavailable';
export type MonochromeCoverageOwner =
  | 'MC4'
  | 'MC5'
  | 'MC7A'
  | 'MC7B'
  | 'MC7C'
  | 'MC7D'
  | 'MC7E'
  | 'MC7F'
  | 'MC7G'
  | 'MC9';

export const MONOCHROME_ZOOM_ROWS = Object.freeze([
  Object.freeze({ label: '100%', factor: 1, surfaceId: 'zoom:100%' }),
  Object.freeze({ label: '125%', factor: 1.25, surfaceId: 'zoom:125%' }),
  Object.freeze({ label: '150%', factor: 1.5, surfaceId: 'zoom:150%' }),
  Object.freeze({ label: '200%', factor: 2, surfaceId: 'zoom:200%' }),
] as const);
export type MonochromeZoomRow = (typeof MONOCHROME_ZOOM_ROWS)[number];
export type MonochromeZoomLabel = MonochromeZoomRow['label'];

export interface MonochromeCoverageEntry {
  readonly id: string;
  readonly kind: MonochromeCoverageKind;
  readonly routeId: MonochromeRouteId | string | null;
  readonly auditStatus: MonochromeAuditStatus;
  readonly availability: MonochromeSurfaceAvailability;
  readonly sourcePaths: readonly string[];
  readonly writerPaths: readonly string[];
  readonly testPaths: readonly string[];
  readonly fixture: Readonly<{ id: MonochromeFixtureId; sha256: string }>;
  readonly behaviorCommands: readonly string[];
  readonly viewports: readonly ['1672x941', '1024x768', 'narrow-desktop'];
  readonly zoom: readonly MonochromeZoomLabel[];
  readonly motion: readonly ['no-preference', 'reduce'];
  readonly preservedBaselineIds: readonly string[];
  readonly owner: MonochromeCoverageOwner;
  readonly logicalLock: string;
  readonly fileLockPaths: readonly string[];
  readonly sharedReadOnlyPaths: readonly string[];
  readonly unavailableReason: string | null;
}

export interface MonochromeMc7Lane {
  readonly id: Extract<MonochromeCoverageOwner, `MC7${string}`>;
  readonly label: string;
  readonly logicalLock: string;
}

export const MONOCHROME_MC7_LANES: readonly MonochromeMc7Lane[] = Object.freeze([
  { id: 'MC7A', label: 'Chat, JARVIS, voice, Command Center', logicalLock: 'monochrome:mc7a' },
  { id: 'MC7B', label: 'Context, Terminal, Workbench, Files', logicalLock: 'monochrome:mc7b' },
  { id: 'MC7C', label: 'Agents, Skills, Tools/plugins, workflows', logicalLock: 'monochrome:mc7c' },
  { id: 'MC7D', label: 'Prompt Forge and Infinite Canvas', logicalLock: 'monochrome:mc7d' },
  {
    id: 'MC7E',
    label: 'Browser Chat, messaging, Browser Operator',
    logicalLock: 'monochrome:mc7e',
  },
  {
    id: 'MC7F',
    label: 'Account, access, billing, providers, settings',
    logicalLock: 'monochrome:mc7f',
  },
  {
    id: 'MC7G',
    label: 'History, Kanban, Schedule, remaining routes',
    logicalLock: 'monochrome:mc7g',
  },
]);

export interface MonochromeRouteCoverageManifest {
  readonly schemaVersion: 2;
  readonly sourceCommit: string;
  readonly derivationCommit: string;
  readonly captureMode: 'retroactive-source-freeze';
  readonly b0RouteManifestSha256: string;
  readonly ownedPaths: readonly string[];
  readonly finalRouteIds: readonly MonochromeRouteId[];
  readonly settingsTabIds: readonly MonochromeSettingsTabId[];
  readonly sharedReadOnlyAuthorities: readonly string[];
  readonly goalSurfaceMap: Readonly<Record<string, readonly string[]>>;
  readonly entries: readonly MonochromeCoverageEntry[];
  readonly validatorCommand: string;
}

export interface MonochromeLegacyRouteEntry {
  readonly id: string;
  readonly sourcePath: string;
  readonly fixtureId: MonochromeFixtureId;
  readonly owner: string;
}

export interface MonochromeLegacyRouteManifest {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly captureMode: 'retroactive-source-freeze';
  readonly ownedPaths: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly fixtureHashes: Readonly<Record<string, string>>;
  readonly consumerTasks: readonly string[];
  readonly validatorCommand: string;
  readonly routes: readonly MonochromeLegacyRouteEntry[];
}

const REPO_ROOT = path.resolve();
const VIEWPORTS = Object.freeze(['1672x941', '1024x768', 'narrow-desktop'] as const);
const ZOOM = Object.freeze(
  MONOCHROME_ZOOM_ROWS.map(({ label }) => label),
) as readonly MonochromeZoomLabel[];
const MOTION = Object.freeze(['no-preference', 'reduce'] as const);
const ROUTE_AUDIT_TEST = 'tests/visual/monochrome/route-manifest.test.ts';
const ROUTE_AUDIT_COMMAND = 'node --test tests/visual/monochrome/route-manifest.test.ts';
const SHELL_AUDIT_TEST = 'tests/visual/monochrome/shell-overlay-manifest.test.ts';
const SHELL_AUDIT_COMMAND = 'node --test tests/visual/monochrome/shell-overlay-manifest.test.ts';
const NATIVE_AUDIT_TEST = 'tests/visual/monochrome/native-window-manifest.test.ts';
const NATIVE_AUDIT_COMMAND = 'node --test tests/visual/monochrome/native-window-manifest.test.ts';
const APP_FULL_REGRESSION_COMMAND = 'npm --prefix app test -- --maxWorkers=1 --minWorkers=1';

function appTestCommand(testPath: string): string {
  if (!testPath.startsWith('app/')) {
    throw new Error(`App test path must begin with app/: ${testPath}`);
  }
  return `npm --prefix app test -- ${testPath.slice('app/'.length)} --maxWorkers=1 --minWorkers=1`;
}

function testCommand(testPath: string): string {
  return testPath.startsWith('app/') ? appTestCommand(testPath) : `node --test ${testPath}`;
}

function functionalBehaviorCommands(
  testPaths: readonly string[],
  structuralCommand?: string,
): readonly string[] {
  const focusedCommands = testPaths
    .filter((testPath) => testPath.startsWith('app/'))
    .map(appTestCommand);
  const commands = focusedCommands.length > 0 ? focusedCommands : [APP_FULL_REGRESSION_COMMAND];
  return Object.freeze([
    ...new Set(structuralCommand ? [...commands, structuralCommand] : commands),
  ]);
}

function behaviorCommandTestPath(command: string): string | null {
  if (command === APP_FULL_REGRESSION_COMMAND) return '*app-regression*';
  const nodeMatch = /^node --test (.+)$/u.exec(command);
  if (nodeMatch) return nodeMatch[1];
  const appMatch = /^npm --prefix app test -- (src\/.+) --maxWorkers=1 --minWorkers=1$/u.exec(
    command,
  );
  return appMatch ? `app/${appMatch[1]}` : null;
}

const FIXTURE_HASHES = MONOCHROME_FIXTURE_MANIFEST.fixtureHashes as Readonly<
  Record<MonochromeFixtureId, string>
>;

const BASELINES: Readonly<Record<MonochromeFixtureId, readonly string[]>> = Object.freeze({
  chat: Object.freeze(['default-chat', 'jarvis-chat', 'vibespace-chat', 'origami-chat']),
  'settings-appearance': Object.freeze([
    'default-settings',
    'jarvis-settings',
    'vibespace-settings',
  ]),
  'terminal-workbench': Object.freeze([
    'default-terminal',
    'jarvis-terminal',
    'vibespace-terminal',
  ]),
});

const ROUTES: Readonly<
  Record<
    MonochromeRouteId,
    Readonly<{
      source: string;
      test: string;
      fixture: MonochromeFixtureId;
      owner: Extract<MonochromeCoverageOwner, `MC7${string}`>;
    }>
  >
> = Object.freeze({
  chat: {
    source: 'app/src/features/chat/ChatView.tsx',
    test: 'app/src/features/chat/ChatView.origamiScope.test.tsx',
    fixture: 'chat',
    owner: 'MC7A',
  },
  canvas: {
    source: 'app/src/features/canvas/CanvasPage.tsx',
    test: 'app/src/features/canvas/CanvasPage.test.tsx',
    fixture: 'chat',
    owner: 'MC7D',
  },
  workbench: {
    source: 'app/src/features/workbench/WorkbenchPage.tsx',
    test: 'app/src/features/workbench/WorkbenchPage.test.tsx',
    fixture: 'terminal-workbench',
    owner: 'MC7B',
  },
  preview: {
    source: 'app/src/features/preview/PreviewStudio.tsx',
    test: 'app/src/features/preview/previewDevices.test.ts',
    fixture: 'chat',
    owner: 'MC7G',
  },
  browser: {
    source: 'app/src/features/browser/BrowserPage.tsx',
    test: 'app/src/features/browser/BrowserPage.approval.test.tsx',
    fixture: 'chat',
    owner: 'MC7E',
  },
  terminal: {
    source: 'app/src/features/terminals/TerminalsPage.tsx',
    test: 'app/src/features/terminals/TerminalsPage.command.test.ts',
    fixture: 'terminal-workbench',
    owner: 'MC7B',
  },
  kanban: {
    source: 'app/src/features/kanban/KanbanPage.tsx',
    test: 'app/src/features/kanban/milestoneKanban.test.ts',
    fixture: 'chat',
    owner: 'MC7G',
  },
  schedule: {
    source: 'app/src/features/schedule/SchedulePage.tsx',
    test: 'app/src/features/schedule/SchedulePage.modelPicker.test.tsx',
    fixture: 'chat',
    owner: 'MC7G',
  },
  agents: {
    source: 'app/src/features/agents/AgentManager.tsx',
    test: 'app/src/features/agents/AgentManager.test.tsx',
    fixture: 'chat',
    owner: 'MC7C',
  },
  'agent-detail': {
    source: 'app/src/features/agents/AgentDetail.tsx',
    test: 'app/src/features/agents/AgentDetail.test.tsx',
    fixture: 'chat',
    owner: 'MC7C',
  },
  'project-detail': {
    source: 'app/src/features/projects/ProjectDetail.tsx',
    test: ROUTE_AUDIT_TEST,
    fixture: 'chat',
    owner: 'MC7G',
  },
  context: {
    source: 'app/src/features/context/ContextPage.tsx',
    test: 'app/src/features/context/contextWorkspaceUi.test.ts',
    fixture: 'terminal-workbench',
    owner: 'MC7B',
  },
  skills: {
    source: 'app/src/features/skills/SkillsPage.tsx',
    test: 'app/src/features/skills/SkillsPage.jarvisCreator.test.tsx',
    fixture: 'chat',
    owner: 'MC7C',
  },
  benchmarks: {
    source: 'app/src/features/benchmarks/BenchmarksPage.tsx',
    test: 'app/src/features/benchmarks/benchmarkData.test.ts',
    fixture: 'chat',
    owner: 'MC7G',
  },
  history: {
    source: 'app/src/features/history/HistoryPage.tsx',
    test: ROUTE_AUDIT_TEST,
    fixture: 'chat',
    owner: 'MC7G',
  },
  tools: {
    source: 'app/src/features/tools/ToolsPage.tsx',
    test: 'app/src/features/tools/toolStore.test.ts',
    fixture: 'chat',
    owner: 'MC7C',
  },
  files: {
    source: 'app/src/features/files/FilesPage.tsx',
    test: 'app/src/features/files/fileExplorerStore.test.ts',
    fixture: 'terminal-workbench',
    owner: 'MC7B',
  },
  account: {
    source: 'app/src/features/account/AccountPage.tsx',
    test: 'app/src/features/account/accountTabs.test.ts',
    fixture: 'settings-appearance',
    owner: 'MC7F',
  },
});

const SETTINGS_SOURCES: Readonly<Record<MonochromeSettingsTabId, string>> = Object.freeze({
  plans: 'app/src/features/settings/sections/Plans.tsx',
  providers: 'app/src/features/settings/sections/Providers.tsx',
  connections: 'app/src/features/settings/sections/SubscriptionCliBridge.tsx',
  hive: 'app/src/features/settings/sections/Hive.tsx',
  allaboutme: 'app/src/features/settings/sections/AllAboutMe.tsx',
  plugins: 'app/src/features/plugins/Plugins.tsx',
  localmodels: 'app/src/features/settings/sections/LocalModels.tsx',
  appearance: 'app/src/features/settings/sections/Appearance.tsx',
  voice: 'app/src/features/settings/sections/Voice.tsx',
  composerstt: 'app/src/features/settings/sections/ComposerStt.tsx',
  phone: 'app/src/features/settings/sections/PhoneVoice.tsx',
  ambient: 'app/src/features/settings/sections/Ambient.tsx',
  notifications: 'app/src/features/settings/sections/Notifications.tsx',
  accessibility: 'app/src/features/settings/sections/Accessibility.tsx',
  hotkeys: 'app/src/features/settings/sections/Hotkeys.tsx',
  jarvisactions: 'app/src/features/settings/sections/JarvisActions.tsx',
  admin: 'app/src/features/settings/sections/Admin.tsx',
  about: 'app/src/features/settings/sections/About.tsx',
});

const SETTINGS_TESTS: Partial<Record<MonochromeSettingsTabId, string>> = Object.freeze({
  appearance: 'app/src/features/settings/sections/Appearance.test.tsx',
  voice: 'app/src/features/settings/sections/Voice.test.tsx',
  phone: 'app/src/features/settings/sections/PhoneVoice.test.tsx',
  allaboutme: 'app/src/features/settings/sections/AllAboutMe.test.tsx',
  connections: 'app/src/features/settings/SubscriptionCliBridge.test.tsx',
  plugins: 'app/src/features/plugins/Plugins.test.tsx',
});

function coverageEntry(input: {
  id: string;
  kind: MonochromeCoverageKind;
  routeId?: MonochromeRouteId | null;
  auditStatus?: MonochromeAuditStatus;
  availability?: MonochromeSurfaceAvailability;
  sourcePaths?: readonly string[];
  writerPaths?: readonly string[];
  testPaths?: readonly string[];
  fixture?: MonochromeFixtureId;
  behaviorCommands?: readonly string[];
  owner: MonochromeCoverageOwner;
  sharedReadOnlyPaths?: readonly string[];
  unavailableReason?: string | null;
}): MonochromeCoverageEntry {
  const fixtureId = input.fixture ?? 'chat';
  const auditStatus = input.auditStatus ?? 'covered';
  const availability =
    input.availability ??
    (auditStatus === 'covered'
      ? 'production'
      : auditStatus === 'development-only'
        ? 'development-only'
        : auditStatus === 'native-only'
          ? 'native-only'
          : 'unavailable');
  const writerPaths = Object.freeze([...(input.writerPaths ?? input.sourcePaths ?? [])]);
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    routeId: input.routeId ?? null,
    auditStatus,
    availability,
    sourcePaths: Object.freeze([...(input.sourcePaths ?? [])]),
    writerPaths,
    testPaths: Object.freeze([...(input.testPaths ?? [ROUTE_AUDIT_TEST])]),
    fixture: Object.freeze({ id: fixtureId, sha256: FIXTURE_HASHES[fixtureId] }),
    behaviorCommands: Object.freeze([...(input.behaviorCommands ?? [ROUTE_AUDIT_COMMAND])]),
    viewports: VIEWPORTS,
    zoom: ZOOM,
    motion: MOTION,
    preservedBaselineIds: Object.freeze([...(BASELINES[fixtureId] ?? [])]),
    owner: input.owner,
    logicalLock: `monochrome:${input.id}`,
    fileLockPaths: writerPaths,
    sharedReadOnlyPaths: Object.freeze([...(input.sharedReadOnlyPaths ?? [])]),
    unavailableReason: input.unavailableReason ?? null,
  });
}

const routeEntries = MONOCHROME_FINAL_ROUTE_IDS.map((routeId) => {
  const route = ROUTES[routeId];
  return coverageEntry({
    id: `route:${routeId}`,
    kind: 'route',
    routeId,
    sourcePaths: [route.source],
    testPaths: [route.test],
    fixture: route.fixture,
    behaviorCommands: functionalBehaviorCommands(
      [route.test],
      route.test.startsWith('app/') ? undefined : testCommand(route.test),
    ),
    owner: route.owner,
    sharedReadOnlyPaths: [
      'app/src/stores/ui.ts',
      'app/src/components/layout/PageRouter.tsx',
      ROUTE_AUDIT_TEST,
    ],
  });
});

const settingsEntries = MONOCHROME_SETTINGS_TAB_IDS.map((tabId) => {
  const testPath = SETTINGS_TESTS[tabId] ?? ROUTE_AUDIT_TEST;
  return coverageEntry({
    id: `settings:${tabId}`,
    kind: 'settings',
    // Hive settings UI is retained for recovery but product-gated by default.
    availability: tabId === 'hive' ? 'feature-flagged' : undefined,
    sourcePaths: [SETTINGS_SOURCES[tabId]],
    testPaths: [testPath],
    fixture: 'settings-appearance',
    behaviorCommands: functionalBehaviorCommands(
      [testPath],
      testPath === ROUTE_AUDIT_TEST ? ROUTE_AUDIT_COMMAND : undefined,
    ),
    owner: 'MC7F',
    sharedReadOnlyPaths: [
      'app/src/features/settings/SettingsModal.tsx',
      'app/src/features/settings/settingsPrefetch.ts',
      ROUTE_AUDIT_TEST,
    ],
  });
});

const SHELL_SHARED_OWNERS = new Map<string, MonochromeCoverageOwner>([
  ['activity-strip', 'MC5'],
  ['app-dispatch', 'MC5'],
  ['app-shell', 'MC5'],
  ['inspector', 'MC5'],
  ['jarvis-context-menu', 'MC5'],
  ['nav-pane', 'MC5'],
  ['page-router', 'MC5'],
  ['tab-strip', 'MC5'],
  ['toaster', 'MC5'],
  ['top-bar', 'MC5'],
  ['workbench-window-dispatch', 'MC9'],
]);

function overlayOwner(id: string): MonochromeCoverageOwner {
  if (SHELL_SHARED_OWNERS.has(id)) return SHELL_SHARED_OWNERS.get(id)!;
  if (
    [
      'assistant-bar-host',
      'call-modal',
      'command-palette-host',
      'global-dictation-overlay',
      'voice-modal-host',
    ].includes(id)
  )
    return 'MC7A';
  if (id === 'file-explorer-host') return 'MC7B';
  if (id === 'actions-palette-host') return 'MC7C';
  if (['api-key-save-burst', 'settings-modal-host'].includes(id)) return 'MC7F';
  return 'MC7G';
}

const overlayEntries = MONOCHROME_SHELL_OVERLAY_MANIFEST.surfaces.map((surface) => {
  const owner = overlayOwner(surface.id);
  const sharedOnly = owner === 'MC5' || owner === 'MC9';
  return coverageEntry({
    id: `overlay:${surface.id}`,
    kind: 'overlay',
    sourcePaths: [surface.sourcePath],
    writerPaths: sharedOnly ? [] : [surface.sourcePath],
    testPaths: [...new Set([...surface.testPaths, SHELL_AUDIT_TEST])],
    fixture: surface.fixtureId,
    behaviorCommands: functionalBehaviorCommands(surface.testPaths, SHELL_AUDIT_COMMAND),
    owner,
    sharedReadOnlyPaths: sharedOnly ? [surface.sourcePath, SHELL_AUDIT_TEST] : [SHELL_AUDIT_TEST],
  });
});

const detachedEntries = MONOCHROME_SHELL_OVERLAY_MANIFEST.detachedViews.map((view) => {
  const surface = MONOCHROME_SHELL_OVERLAY_MANIFEST.surfaces.find(
    ({ id }) => id === view.surfaceId,
  )!;
  return coverageEntry({
    id: `detached:${view.id}`,
    kind: 'detached',
    sourcePaths: [surface.sourcePath],
    writerPaths: [],
    testPaths: [...new Set([...surface.testPaths, SHELL_AUDIT_TEST])],
    fixture: surface.fixtureId,
    behaviorCommands: functionalBehaviorCommands(surface.testPaths, SHELL_AUDIT_COMMAND),
    owner: 'MC9',
    sharedReadOnlyPaths: [surface.sourcePath, SHELL_AUDIT_TEST],
  });
});

const nativeEntries = MONOCHROME_NATIVE_WINDOW_MANIFEST.surfaces.map((surface) =>
  coverageEntry({
    id: `native:${surface.label}`,
    kind: 'native',
    auditStatus: 'native-only',
    sourcePaths: [surface.sourcePath],
    writerPaths: [],
    testPaths: [NATIVE_AUDIT_TEST],
    fixture: surface.label === 'workbench-main' ? 'terminal-workbench' : 'chat',
    behaviorCommands: [APP_FULL_REGRESSION_COMMAND, NATIVE_AUDIT_COMMAND],
    owner: 'MC9',
    sharedReadOnlyPaths: [surface.sourcePath, NATIVE_AUDIT_TEST],
  }),
);

const accessEntries = [
  coverageEntry({
    id: 'access:app-host',
    kind: 'access',
    availability: 'feature-flagged',
    sourcePaths: ['app/src/features/access/AccessAppHost.tsx'],
    testPaths: ['app/src/features/access/AccessAppHost.test.tsx'],
    fixture: 'settings-appearance',
    behaviorCommands: [appTestCommand('app/src/features/access/AccessAppHost.test.tsx')],
    owner: 'MC7F',
  }),
  coverageEntry({
    id: 'access:banner',
    kind: 'access',
    availability: 'feature-flagged',
    sourcePaths: ['app/src/features/access/AccessBanner.tsx'],
    testPaths: ['app/src/features/access/AccessBanner.test.tsx'],
    fixture: 'settings-appearance',
    behaviorCommands: [appTestCommand('app/src/features/access/AccessBanner.test.tsx')],
    owner: 'MC7F',
  }),
  coverageEntry({
    id: 'access:locked',
    kind: 'access',
    availability: 'feature-flagged',
    sourcePaths: ['app/src/features/access/AccessPaywall.tsx'],
    testPaths: ['app/src/features/access/AccessPaywall.test.tsx'],
    fixture: 'settings-appearance',
    behaviorCommands: [appTestCommand('app/src/features/access/AccessPaywall.test.tsx')],
    owner: 'MC7F',
  }),
];

const embeddedAndFutureEntries = [
  coverageEntry({
    id: 'embedded:command-center',
    kind: 'embedded',
    sourcePaths: ['app/src/features/jarvis-command-center/JarvisCommandCenter.tsx'],
    testPaths: ['app/src/features/jarvis-command-center/JarvisCommandCenter.test.tsx'],
    behaviorCommands: [
      appTestCommand('app/src/features/jarvis-command-center/JarvisCommandCenter.test.tsx'),
    ],
    owner: 'MC7A',
  }),
  coverageEntry({
    id: 'embedded:prompt-forge',
    kind: 'embedded',
    sourcePaths: ['app/src/features/prompt-forge/PromptForgeControl.tsx'],
    testPaths: ['app/src/features/prompt-forge/PromptForgeControl.test.tsx'],
    behaviorCommands: [appTestCommand('app/src/features/prompt-forge/PromptForgeControl.test.tsx')],
    owner: 'MC7D',
  }),
  coverageEntry({
    id: 'embedded:browser-operator',
    kind: 'embedded',
    sourcePaths: ['app/src/features/browser/browserActions.ts'],
    writerPaths: [],
    testPaths: ['app/src/features/browser/browserActions.test.ts'],
    behaviorCommands: [appTestCommand('app/src/features/browser/browserActions.test.ts')],
    owner: 'MC7E',
    sharedReadOnlyPaths: [
      'app/src/features/browser/BrowserPage.tsx',
      'app/src/features/browser/browserActions.ts',
    ],
  }),
  coverageEntry({
    id: 'future:messaging-channels',
    kind: 'future',
    auditStatus: 'unavailable',
    sourcePaths: [],
    writerPaths: [],
    testPaths: [ROUTE_AUDIT_TEST],
    behaviorCommands: [ROUTE_AUDIT_COMMAND],
    owner: 'MC7E',
    unavailableReason:
      'Messaging and channel management are not a production visual surface in the final source-derived union.',
  }),
  coverageEntry({
    id: 'development:monochrome-workbench',
    kind: 'development',
    auditStatus: 'development-only',
    sourcePaths: ['app/src/features/appearance/MonochromeWorkbench.tsx'],
    writerPaths: [],
    testPaths: ['app/src/features/appearance/MonochromeWorkbench.test.tsx'],
    fixture: 'terminal-workbench',
    behaviorCommands: [appTestCommand('app/src/features/appearance/MonochromeWorkbench.test.tsx')],
    owner: 'MC4',
    sharedReadOnlyPaths: [
      'app/src/features/appearance/MonochromeWorkbench.tsx',
      'app/src/features/appearance/MonochromeWorkbench.test.tsx',
    ],
  }),
];

const COVERAGE_ENTRIES = Object.freeze(
  [
    ...routeEntries,
    ...settingsEntries,
    ...accessEntries,
    ...overlayEntries,
    ...detachedEntries,
    ...nativeEntries,
    ...embeddedAndFutureEntries,
  ].sort((left, right) => left.id.localeCompare(right.id)),
);

export const MONOCHROME_ROUTE_COVERAGE_MANIFEST: MonochromeRouteCoverageManifest = Object.freeze({
  schemaVersion: 2,
  sourceCommit: MONOCHROME_SOURCE_COMMIT,
  derivationCommit: '041c914da680d4ee5d5c091573e5582b17f18484',
  captureMode: 'retroactive-source-freeze',
  b0RouteManifestSha256: 'cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796',
  ownedPaths: Object.freeze([
    'docs/appearance/monochrome/route-coverage.md',
    'tests/visual/monochrome/route-manifest.test.ts',
    'tests/visual/monochrome/route-manifest.ts',
  ]),
  finalRouteIds: MONOCHROME_FINAL_ROUTE_IDS,
  settingsTabIds: MONOCHROME_SETTINGS_TAB_IDS,
  sharedReadOnlyAuthorities: Object.freeze([
    'app/src/components/layout/PageRouter.tsx',
    'app/src/stores/ui.ts',
    'tests/visual/monochrome/baseline-manifest.ts',
    'tests/visual/monochrome/fixture-manifest.ts',
    'tests/visual/monochrome/native-window-manifest.ts',
    'tests/visual/monochrome/shell-overlay-manifest.ts',
  ]),
  goalSurfaceMap: Object.freeze({
    account: Object.freeze(['route:account']),
    agents: Object.freeze(['route:agents', 'route:agent-detail']),
    'billing-plans': Object.freeze(['route:account', 'settings:plans']),
    'browser-chat': Object.freeze(['route:browser']),
    'browser-operator': Object.freeze(['route:browser', 'embedded:browser-operator']),
    canvas: Object.freeze(['route:canvas']),
    chat: Object.freeze(['route:chat']),
    'command-center': Object.freeze(['embedded:command-center']),
    context: Object.freeze(['route:context']),
    files: Object.freeze(['route:files']),
    'history-recall': Object.freeze(['route:history']),
    kanban: Object.freeze(['route:kanban']),
    'locked-access': Object.freeze(['access:app-host', 'access:banner', 'access:locked']),
    'messaging-channels': Object.freeze(['future:messaging-channels']),
    'prompt-forge': Object.freeze(['embedded:prompt-forge']),
    providers: Object.freeze(['settings:providers', 'settings:localmodels']),
    schedule: Object.freeze(['route:schedule']),
    settings: Object.freeze(MONOCHROME_SETTINGS_TAB_IDS.map((tab) => `settings:${tab}`)),
    skills: Object.freeze(['route:skills']),
    terminal: Object.freeze(['route:terminal']),
    'tools-plugins': Object.freeze(['route:tools', 'settings:plugins']),
    usage: Object.freeze(['route:account']),
    workbench: Object.freeze(['route:workbench', 'detached:workbench-main']),
  }),
  entries: COVERAGE_ENTRIES,
  validatorCommand: ROUTE_AUDIT_COMMAND,
});

function isStableUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0)
  );
}

function currentSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function sourceDerivedRouteUnion(): string[] {
  const source = currentSource('app/src/stores/ui.ts');
  const start = source.indexOf('export type Route =');
  const block = source.slice(start, source.indexOf(';', start));
  return [...block.matchAll(/\|\s*'([^']+)'/gu)].map((match) => match[1]);
}

function sourceDerivedRouterDispatch(): string[] {
  const source = currentSource('app/src/components/layout/PageRouter.tsx');
  const start = source.indexOf('const routeMap:');
  const block = source.slice(start, source.indexOf('};', start));
  return [...block.matchAll(/^\s*(?:'([^']+)'|([a-z-]+)):\s*[A-Z]/gmu)].map(
    (match) => match[1] ?? match[2],
  );
}

function sourceDerivedSettingsTabs(): string[] {
  const source = currentSource('app/src/features/settings/settingsPrefetch.ts');
  const start = source.indexOf('export type SettingsTab =');
  const block = source.slice(start, source.indexOf(';', start));
  return [...block.matchAll(/\|\s*'([^']+)'/gu)].map((match) => match[1]);
}

export function validateMonochromeRouteCoverageManifest(
  manifest: MonochromeRouteCoverageManifest,
): string[] {
  const errors: string[] = [];
  const entryIds = manifest.entries.map(({ id }) => id);
  const currentRoutes = sourceDerivedRouteUnion();
  const currentDispatch = sourceDerivedRouterDispatch();
  const currentSettings = sourceDerivedSettingsTabs();
  const knownRouteIds = new Set(currentRoutes);

  if (manifest.schemaVersion !== 2) errors.push('unsupported schema version');
  if (JSON.stringify(manifest.finalRouteIds) !== JSON.stringify(currentRoutes)) {
    errors.push('source-derived route union drift');
  }
  if (JSON.stringify(manifest.finalRouteIds) !== JSON.stringify(currentDispatch)) {
    errors.push('source-derived router dispatch drift');
  }
  if (JSON.stringify(manifest.settingsTabIds) !== JSON.stringify(currentSettings)) {
    errors.push('source-derived settings union drift');
  }
  if (!isStableUnique(entryIds)) {
    if (new Set(entryIds).size !== entryIds.length) errors.push('duplicate entry id');
    else errors.push('coverage entries are not in stable order');
  }
  const expectedEntryIds = COVERAGE_ENTRIES.map(({ id }) => id);
  if (JSON.stringify(entryIds) !== JSON.stringify(expectedEntryIds)) {
    errors.push('coverage entry closure mismatch');
  }
  if (new Set(manifest.finalRouteIds).size !== manifest.finalRouteIds.length) {
    errors.push('duplicate final route id');
  }

  const expectedRouteEntryIds = currentRoutes.map((routeId) => `route:${routeId}`).sort();
  const actualRouteEntryIds = manifest.entries
    .filter(({ kind }) => kind === 'route')
    .map(({ id }) => id)
    .sort();
  if (JSON.stringify(actualRouteEntryIds) !== JSON.stringify(expectedRouteEntryIds)) {
    errors.push('route entry closure mismatch');
  }
  const expectedSettingsEntryIds = currentSettings.map((tabId) => `settings:${tabId}`).sort();
  const actualSettingsEntryIds = manifest.entries
    .filter(({ kind }) => kind === 'settings')
    .map(({ id }) => id)
    .sort();
  if (JSON.stringify(actualSettingsEntryIds) !== JSON.stringify(expectedSettingsEntryIds)) {
    errors.push('settings entry closure mismatch');
  }

  for (const routeId of manifest.finalRouteIds) {
    if (!entryIds.includes(`route:${routeId}`)) errors.push(`missing production route: ${routeId}`);
  }
  for (const tabId of manifest.settingsTabIds) {
    if (!entryIds.includes(`settings:${tabId}`)) errors.push(`missing settings surface: ${tabId}`);
  }
  for (const accessId of ['access:app-host', 'access:banner', 'access:locked']) {
    if (!entryIds.includes(accessId)) errors.push(`missing access surface: ${accessId}`);
  }

  const writerOwners = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (
      (entry.kind === 'route') !== entry.id.startsWith('route:') ||
      (entry.kind === 'settings') !== entry.id.startsWith('settings:')
    ) {
      errors.push(`coverage kind/id namespace mismatch: ${entry.id}`);
    }
    if (
      entry.kind === 'route' &&
      (entry.routeId === null || !knownRouteIds.has(entry.routeId as MonochromeRouteId))
    ) {
      errors.push(`route id outside final route union: ${entry.id}`);
    }
    if (entry.kind === 'route' && entry.id !== `route:${entry.routeId}`) {
      errors.push(`route entry id/route id mismatch: ${entry.id}`);
    }
    if (JSON.stringify(entry.zoom) !== JSON.stringify(ZOOM)) {
      errors.push(`zoom authority mismatch: ${entry.id}`);
    }
    if (
      entry.behaviorCommands.length === 0 ||
      entry.behaviorCommands.some((command) => !command.trim())
    ) {
      errors.push(`missing behavior command: ${entry.id}`);
    }
    for (const command of entry.behaviorCommands) {
      const commandTestPath = behaviorCommandTestPath(command);
      if (!commandTestPath) {
        errors.push(`invalid behavior command: ${entry.id}: ${command}`);
      } else if (
        commandTestPath !== '*app-regression*' &&
        !entry.testPaths.includes(commandTestPath)
      ) {
        errors.push(`behavior command/test mismatch: ${entry.id}: ${commandTestPath}`);
      }
    }
    if (entry.auditStatus === 'unavailable') {
      if (
        entry.availability !== 'unavailable' ||
        entry.sourcePaths.length > 0 ||
        entry.writerPaths.length > 0 ||
        (entry.unavailableReason?.trim().length ?? 0) < 16
      ) {
        errors.push(`invalid unavailable surface: ${entry.id}`);
      }
    } else {
      if (
        !entry.behaviorCommands.some((command) => command.startsWith('npm --prefix app test --'))
      ) {
        errors.push(`missing functional behavior command: ${entry.id}`);
      }
      if (
        (entry.auditStatus === 'native-only' && entry.availability !== 'native-only') ||
        (entry.auditStatus === 'development-only' && entry.availability !== 'development-only') ||
        entry.availability === 'unavailable'
      ) {
        errors.push(`availability mismatch: ${entry.id}`);
      }
      if (entry.sourcePaths.length === 0)
        errors.push(`available entry missing source: ${entry.id}`);
      if (entry.testPaths.length === 0) errors.push(`available entry missing test: ${entry.id}`);
      for (const sourcePath of entry.sourcePaths) {
        if (!existsSync(path.join(REPO_ROOT, sourcePath))) {
          errors.push(`nonexistent source: ${entry.id}: ${sourcePath}`);
        }
      }
      for (const testPath of entry.testPaths) {
        if (!existsSync(path.join(REPO_ROOT, testPath))) {
          errors.push(`nonexistent test: ${entry.id}: ${testPath}`);
        }
      }
      if (FIXTURE_HASHES[entry.fixture.id] !== entry.fixture.sha256) {
        errors.push(`fixture hash mismatch: ${entry.id}`);
      }
      if (entry.preservedBaselineIds.length === 0) {
        errors.push(`missing preserved-theme baseline: ${entry.id}`);
      }
    }
    if (JSON.stringify(entry.fileLockPaths) !== JSON.stringify(entry.writerPaths)) {
      errors.push(`file lock mismatch: ${entry.id}`);
    }
    for (const writerPath of entry.writerPaths) {
      if (!entry.sourcePaths.includes(writerPath)) {
        errors.push(`writer path is not a source: ${entry.id}: ${writerPath}`);
      }
      const priorOwner = writerOwners.get(writerPath);
      if (priorOwner)
        errors.push(`writer path overlap: ${writerPath} (${priorOwner}, ${entry.id})`);
      else writerOwners.set(writerPath, entry.id);
    }
  }

  const knownEntries = new Set(entryIds);
  for (const [goalId, mappedEntries] of Object.entries(manifest.goalSurfaceMap)) {
    if (mappedEntries.length === 0) errors.push(`empty Goal 8 mapping: ${goalId}`);
    for (const entryId of mappedEntries) {
      if (!knownEntries.has(entryId)) errors.push(`unknown Goal 8 entry: ${goalId}: ${entryId}`);
    }
  }

  return errors;
}

/**
 * Frozen schema-v1 compatibility authority for MC0B/MC5 aggregate consumers.
 * New MC6/MC7 work must use the schema-v2 coverage authority above.
 */
export const MONOCHROME_ROUTE_MANIFEST: MonochromeLegacyRouteManifest = Object.freeze({
  schemaVersion: 1,
  sourceCommit: MONOCHROME_SOURCE_COMMIT,
  captureMode: 'retroactive-source-freeze',
  ownedPaths: Object.freeze([
    'tests/visual/monochrome/route-manifest.test.ts',
    'tests/visual/monochrome/route-manifest.ts',
  ]),
  fixtureIds: MONOCHROME_FIXTURE_MANIFEST.fixtureIds,
  fixtureHashes: MONOCHROME_FIXTURE_MANIFEST.fixtureHashes,
  consumerTasks: Object.freeze(['MC5', 'MC6', 'MC7']),
  validatorCommand: ROUTE_AUDIT_COMMAND,
  routes: Object.freeze(
    [
      ['account', 'app/src/features/account/index.ts', 'settings-appearance'],
      ['agent-detail', 'app/src/features/agents/index.ts', 'chat'],
      ['agents', 'app/src/features/agents/index.ts', 'chat'],
      ['benchmarks', 'app/src/features/benchmarks/index.ts', 'chat'],
      ['browser', 'app/src/features/browser/index.ts', 'chat'],
      ['canvas', 'app/src/features/canvas/index.ts', 'chat'],
      ['chat', 'app/src/features/chat/index.ts', 'chat'],
      ['context', 'app/src/features/context/index.ts', 'chat'],
      ['files', 'app/src/features/files/index.ts', 'chat'],
      ['history', 'app/src/features/history/index.ts', 'chat'],
      ['kanban', 'app/src/features/kanban/index.ts', 'chat'],
      ['preview', 'app/src/features/preview/index.ts', 'chat'],
      ['project-detail', 'app/src/features/projects/index.ts', 'chat'],
      ['schedule', 'app/src/features/schedule/index.ts', 'chat'],
      ['skills', 'app/src/features/skills/index.ts', 'chat'],
      ['terminal', 'app/src/features/terminals/TerminalsPage.tsx', 'terminal-workbench'],
      ['tools', 'app/src/features/tools/index.ts', 'chat'],
      ['workbench', 'app/src/features/workbench/index.ts', 'terminal-workbench'],
    ].map(([id, sourcePath, fixtureId]) =>
      Object.freeze({
        id,
        sourcePath,
        fixtureId: fixtureId as MonochromeFixtureId,
        owner: `route:${id}`,
      }),
    ),
  ),
});

const LEGACY_OWNED_PATHS = [
  'tests/visual/monochrome/route-manifest.test.ts',
  'tests/visual/monochrome/route-manifest.ts',
] as const;

export function validateMonochromeRouteManifest(manifest: MonochromeLegacyRouteManifest): string[] {
  const errors: string[] = [];
  const ids = manifest.routes.map(({ id }) => id);
  if (!isStableUnique(ids)) {
    if (new Set(ids).size !== ids.length) errors.push('duplicate route id');
    else errors.push('routes are not in stable order');
  }
  if (manifest.routes.some(({ owner }) => !owner.startsWith('route:'))) {
    errors.push('route owner missing');
  }
  if (JSON.stringify(manifest.ownedPaths) !== JSON.stringify(LEGACY_OWNED_PATHS)) {
    errors.push('owned path overlap or drift');
  }
  return errors;
}
