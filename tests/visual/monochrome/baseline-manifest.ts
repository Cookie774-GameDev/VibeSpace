// @ts-expect-error TS5097 -- Direct Node test execution requires the explicit .ts extension.
import { MONOCHROME_ROUTE_COVERAGE_MANIFEST } from './route-manifest.ts';

export type BaselineThemeId = 'default' | 'jarvis' | 'vibespace';
export type BaselineDocumentTheme = 'dark' | 'jarvis' | 'vibespace';
export type BaselineFixtureId = 'chat' | 'settings-appearance' | 'terminal-workbench';
export type BaselineCaptureState =
  | 'generic-mc0b-chat'
  | 'generic-mc0b-settings'
  | 'generic-mc0b-terminal'
  | 'frozen-origami-acceptance';

export interface MonochromeBaselineCapture {
  readonly caseId: string;
  readonly outputPath: string;
  readonly themeId: BaselineThemeId;
  readonly documentTheme: BaselineDocumentTheme;
  readonly route: 'chat' | 'settings-appearance' | 'terminal';
  readonly underlyingRoute: 'chat' | 'terminal';
  readonly captureState: BaselineCaptureState;
  readonly fixtureId: BaselineFixtureId;
  readonly origamiGateActive: boolean;
  readonly fontReady: boolean;
  readonly fontCount: number;
  readonly stableLayout: boolean;
  readonly unexpectedPageErrors: number;
  readonly sha256: string;
}

export interface MonochromeBaselineManifest {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly harnessCommit: string;
  readonly routeManifestSha256: string;
  readonly fixtureSourceSha256: string;
  readonly fixtureManifestSha256: string;
  readonly origamiFixtureSourceSha256: string;
  readonly captureFixtureSha256: string;
  readonly browserSource: 'msedge';
  readonly viewport: Readonly<{ width: 1672; height: 941; deviceScaleFactor: 1 }>;
  readonly environment: Readonly<{
    locale: 'en-US';
    timezoneId: 'UTC';
    colorScheme: 'light';
    reducedMotion: 'reduce';
    fixedClock: '2026-07-16T12:00:00.000Z';
    fontReadiness: 'document.fonts.ready';
    stableLayout: 'three-consecutive-animation-frames';
    navigation: 'loopback-only';
    dataSource: 'isolated-synthetic-fixtures';
  }>;
  readonly ownedPaths: readonly string[];
  readonly captures: readonly MonochromeBaselineCapture[];
  readonly validatorCommand: string;
}

export type MonochromeMc9BaselineKind =
  | 'browser-surface'
  | 'named-state'
  | 'viewport'
  | 'a11y-route'
  | 'forced-colors';

export interface MonochromeMc9BaselineEntry {
  readonly id: string;
  readonly kind: MonochromeMc9BaselineKind;
  readonly outputPath: string;
}

export interface MonochromeMc9BaselineManifest {
  readonly schemaVersion: 1;
  readonly baselineRoot: 'tests/visual/monochrome/baselines/mc9';
  readonly expectedPngCount: 111;
  readonly entries: readonly MonochromeMc9BaselineEntry[];
}

const CAPTURES: readonly MonochromeBaselineCapture[] = Object.freeze([
  {
    caseId: 'default-chat',
    outputPath: 'tests/visual/monochrome/baselines/b0/default/chat.png',
    themeId: 'default',
    documentTheme: 'dark',
    route: 'chat',
    underlyingRoute: 'chat',
    captureState: 'generic-mc0b-chat',
    fixtureId: 'chat',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '02753d5f6ac3f3d3381cd71142b57ed24cd34c8164baa50cd1fcb9bb0b2f6a3a',
  },
  {
    caseId: 'default-settings',
    outputPath: 'tests/visual/monochrome/baselines/b0/default/settings-appearance.png',
    themeId: 'default',
    documentTheme: 'dark',
    route: 'settings-appearance',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-settings',
    fixtureId: 'settings-appearance',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: 'b49a1abe47d6953f9b2b1640ebc3a7822d4fcb9904e774fa1b61f30ceb53076e',
  },
  {
    caseId: 'default-terminal',
    outputPath: 'tests/visual/monochrome/baselines/b0/default/terminal-workbench.png',
    themeId: 'default',
    documentTheme: 'dark',
    route: 'terminal',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-terminal',
    fixtureId: 'terminal-workbench',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: 'e198c1504ba24953bb98b3f02cb6541cc7e275293be6fcebdc3879becc39fe2c',
  },
  {
    caseId: 'jarvis-chat',
    outputPath: 'tests/visual/monochrome/baselines/b0/jarvis/chat.png',
    themeId: 'jarvis',
    documentTheme: 'jarvis',
    route: 'chat',
    underlyingRoute: 'chat',
    captureState: 'generic-mc0b-chat',
    fixtureId: 'chat',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '60edaeef44de36b08b78c5a6f9e5a192892206774753a53a7840a2d94d783685',
  },
  {
    caseId: 'jarvis-settings',
    outputPath: 'tests/visual/monochrome/baselines/b0/jarvis/settings-appearance.png',
    themeId: 'jarvis',
    documentTheme: 'jarvis',
    route: 'settings-appearance',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-settings',
    fixtureId: 'settings-appearance',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '702e71fab064e7abf54585e37da6a5056d6b6c83f7209c92b8c35288ce2060b1',
  },
  {
    caseId: 'jarvis-terminal',
    outputPath: 'tests/visual/monochrome/baselines/b0/jarvis/terminal-workbench.png',
    themeId: 'jarvis',
    documentTheme: 'jarvis',
    route: 'terminal',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-terminal',
    fixtureId: 'terminal-workbench',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: 'ac76229cc7e36456d019cab04a927284cd3c39d4a3dfccb0bd0ef460994b4fc8',
  },
  {
    caseId: 'origami-chat',
    outputPath: 'tests/visual/monochrome/baselines/b0/origami/chat.png',
    themeId: 'vibespace',
    documentTheme: 'vibespace',
    route: 'chat',
    underlyingRoute: 'chat',
    captureState: 'frozen-origami-acceptance',
    fixtureId: 'chat',
    origamiGateActive: true,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '2f5a34cdbb8b1f1b54f523f13db3f2864acf67a392b02561cca65fe1c6cb9582',
  },
  {
    caseId: 'vibespace-chat',
    outputPath: 'tests/visual/monochrome/baselines/b0/vibespace/chat.png',
    themeId: 'vibespace',
    documentTheme: 'vibespace',
    route: 'chat',
    underlyingRoute: 'chat',
    captureState: 'generic-mc0b-chat',
    fixtureId: 'chat',
    origamiGateActive: true,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: 'b66da8f343c31f4e4ca9e62cf6bbeb1309fc18d5adc24837b560fa881e41f9b8',
  },
  {
    caseId: 'vibespace-settings',
    outputPath: 'tests/visual/monochrome/baselines/b0/vibespace/settings-appearance.png',
    themeId: 'vibespace',
    documentTheme: 'vibespace',
    route: 'settings-appearance',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-settings',
    fixtureId: 'settings-appearance',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '453a8870cc9fe4c5e6b02d7ddb608c9db9e94f5ca563f2c5876c77354ae92a0c',
  },
  {
    caseId: 'vibespace-terminal',
    outputPath: 'tests/visual/monochrome/baselines/b0/vibespace/terminal-workbench.png',
    themeId: 'vibespace',
    documentTheme: 'vibespace',
    route: 'terminal',
    underlyingRoute: 'terminal',
    captureState: 'generic-mc0b-terminal',
    fixtureId: 'terminal-workbench',
    origamiGateActive: false,
    fontReady: true,
    fontCount: 71,
    stableLayout: true,
    unexpectedPageErrors: 0,
    sha256: '9f88c2f3a211905c2004ac94ac25c5e8e06cd834cbb0695104014dc39e0d8a0e',
  },
]);

const OWNED_PATHS = Object.freeze([
  'tests/visual/monochrome/baseline-manifest.test.ts',
  'tests/visual/monochrome/baseline-manifest.ts',
  ...CAPTURES.map(({ outputPath }) => outputPath),
]);

export const MONOCHROME_BASELINE_MANIFEST: MonochromeBaselineManifest = Object.freeze({
  schemaVersion: 1,
  sourceCommit: '7eb708e184ee4f054a49d3e70d73e80fd4eb97ae',
  harnessCommit: '023844c789843e452aab7aad952f8392908d92de',
  routeManifestSha256: 'cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796',
  fixtureSourceSha256: '5dfacca26708b83f8938bb75e0b63b8feb964bb741629bf66d96abbda6e2da4f',
  fixtureManifestSha256: '5994a5ef08d14517e100c0c886f54478bab1fcb462abd0c17af4bb695a7a778e',
  origamiFixtureSourceSha256: '4db0e6aafcc439be18b5103d135bdd2e79d6f26976b04eb0c9c57e2225fd72fc',
  captureFixtureSha256: '48759d692d069850a3b2f734823ec06b2fcf62a667d984d52ec30247d25c4ec9',
  browserSource: 'msedge',
  viewport: Object.freeze({ width: 1672, height: 941, deviceScaleFactor: 1 }),
  environment: Object.freeze({
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    fixedClock: '2026-07-16T12:00:00.000Z',
    fontReadiness: 'document.fonts.ready',
    stableLayout: 'three-consecutive-animation-frames',
    navigation: 'loopback-only',
    dataSource: 'isolated-synthetic-fixtures',
  }),
  ownedPaths: OWNED_PATHS,
  captures: CAPTURES,
  validatorCommand: 'node --test tests/visual/monochrome/baseline-manifest.test.ts',
});

const MC9_BASELINE_ROOT = 'tests/visual/monochrome/baselines/mc9';
const MC9_VISUAL_DIRECTORY = `${MC9_BASELINE_ROOT}/monochrome-visual/monochrome.visual.spec.ts`;
const MC9_A11Y_DIRECTORY = `${MC9_BASELINE_ROOT}/monochrome-a11y/monochrome.a11y.spec.ts`;
const MC9_NAMED_STATE_IDS = Object.freeze([
  'usage',
  'billing-plans',
  'dropdown-open',
  'tooltip-visible',
  'empty-state',
  'modal-open',
  'toast-visible',
  'locked-access',
] as const);
const MC9_VIEWPORT_IDS = Object.freeze([
  '1672x941',
  '1440x900',
  '1280x720',
  '1024x768',
  'narrow-desktop-960x600',
] as const);

function mc9Entry(
  id: string,
  kind: MonochromeMc9BaselineKind,
  outputPath: string,
): MonochromeMc9BaselineEntry {
  return Object.freeze({ id, kind, outputPath });
}

const MC9_ENTRIES = Object.freeze(
  [
    ...MONOCHROME_ROUTE_COVERAGE_MANIFEST.entries
      .filter(({ auditStatus }) => auditStatus !== 'native-only' && auditStatus !== 'unavailable')
      .map(({ id }) =>
        mc9Entry(
          id,
          'browser-surface',
          `${MC9_VISUAL_DIRECTORY}/${id.replaceAll(':', '--').replaceAll('/', '-')}.png`,
        ),
      ),
    ...MC9_NAMED_STATE_IDS.map((id) =>
      mc9Entry(`state:${id}`, 'named-state', `${MC9_VISUAL_DIRECTORY}/named-state--${id}.png`),
    ),
    ...MC9_VIEWPORT_IDS.map((id) =>
      mc9Entry(`viewport:${id}`, 'viewport', `${MC9_VISUAL_DIRECTORY}/viewport--${id}.png`),
    ),
    // Account moved from the Settings modal to its own route after this immutable
    // corpus was captured. Retain the historical image as evidence instead of
    // coupling an already-recorded corpus to the live route inventory.
    mc9Entry(
      'settings:account',
      'browser-surface',
      `${MC9_VISUAL_DIRECTORY}/settings--account.png`,
    ),
    ...MONOCHROME_ROUTE_COVERAGE_MANIFEST.entries
      .filter(
        (entry): entry is typeof entry & { readonly routeId: string } =>
          entry.kind === 'route' && entry.routeId !== null,
      )
      .map(({ routeId }) =>
        mc9Entry(
          `a11y:route:${routeId}`,
          'a11y-route',
          `${MC9_A11Y_DIRECTORY}/a11y-route--${routeId}--1440x900.png`,
        ),
      ),
    mc9Entry(
      'a11y:forced-colors',
      'forced-colors',
      `${MC9_A11Y_DIRECTORY}/forced-colors--chat.png`,
    ),
  ].sort((left, right) => left.outputPath.localeCompare(right.outputPath)),
);

export const MONOCHROME_MC9_BASELINE_MANIFEST: MonochromeMc9BaselineManifest = Object.freeze({
  schemaVersion: 1,
  baselineRoot: MC9_BASELINE_ROOT,
  expectedPngCount: 111,
  entries: MC9_ENTRIES,
});

function stableUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0)
  );
}

function safeMc9OutputPath(outputPath: string): boolean {
  return (
    outputPath.startsWith(`${MC9_BASELINE_ROOT}/`) &&
    /^[a-z0-9./-]+\.png$/u.test(outputPath) &&
    !outputPath.includes('\\') &&
    outputPath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

export function validateMonochromeMc9BaselineManifest(
  manifest: MonochromeMc9BaselineManifest,
  actualOutputPaths: readonly string[],
): string[] {
  const errors: string[] = [];
  const ids = manifest.entries.map(({ id }) => id);
  const paths = manifest.entries.map(({ outputPath }) => outputPath);

  if (manifest.schemaVersion !== 1) errors.push('MC9 schema version drift');
  if (manifest.baselineRoot !== MC9_BASELINE_ROOT) errors.push('MC9 baseline root drift');
  if (manifest.expectedPngCount !== 111 || manifest.entries.length !== manifest.expectedPngCount) {
    errors.push('MC9 baseline count drift');
  }
  if (new Set(ids).size !== ids.length) errors.push('duplicate MC9 baseline id');
  if (!stableUnique(paths)) errors.push('duplicate MC9 baseline path or unstable order');
  if (manifest.entries.some(({ outputPath }) => !safeMc9OutputPath(outputPath))) {
    errors.push('unsafe MC9 baseline output path');
  }
  if (JSON.stringify(manifest.entries) !== JSON.stringify(MC9_ENTRIES)) {
    errors.push('MC9 baseline authority closure drift');
  }

  if (!stableUnique(actualOutputPaths)) {
    errors.push('duplicate MC9 corpus path or unstable order');
  }
  const expectedPaths = new Set(paths);
  const actualPaths = new Set(actualOutputPaths);
  for (const outputPath of paths) {
    if (!actualPaths.has(outputPath)) errors.push(`missing MC9 baseline: ${outputPath}`);
  }
  for (const outputPath of actualOutputPaths) {
    if (!expectedPaths.has(outputPath)) errors.push(`orphan MC9 baseline: ${outputPath}`);
  }

  return errors;
}

export function validateMonochromeBaselineManifest(manifest: MonochromeBaselineManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push('schema version drift');
  if (manifest.sourceCommit !== MONOCHROME_BASELINE_MANIFEST.sourceCommit) {
    errors.push('source commit drift');
  }
  if (manifest.harnessCommit !== MONOCHROME_BASELINE_MANIFEST.harnessCommit) {
    errors.push('harness commit drift');
  }
  if (JSON.stringify(manifest.ownedPaths) !== JSON.stringify(OWNED_PATHS)) {
    errors.push('owned path drift');
  }
  const ids = manifest.captures.map(({ caseId }) => caseId);
  const paths = manifest.captures.map(({ outputPath }) => outputPath);
  if (manifest.captures.length !== 10) errors.push('capture count drift');
  if (new Set(ids).size !== ids.length) errors.push('duplicate case id');
  if (new Set(paths).size !== paths.length) errors.push('duplicate output path');
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    errors.push('capture path order drift');
  }
  if (JSON.stringify(manifest.captures) !== JSON.stringify(CAPTURES)) {
    errors.push('capture authority drift');
  }
  for (const capture of manifest.captures) {
    if (!/^[a-f0-9]{64}$/u.test(capture.sha256)) errors.push(`hash drift: ${capture.caseId}`);
    if (!capture.fontReady || !capture.stableLayout) {
      errors.push(`readiness drift: ${capture.caseId}`);
    }
    if (capture.unexpectedPageErrors !== 0) errors.push(`page error drift: ${capture.caseId}`);
    const expectedGate = capture.route === 'chat' && capture.documentTheme === 'vibespace';
    if (capture.origamiGateActive !== expectedGate) {
      errors.push(`Origami gate drift: ${capture.caseId}`);
    }
    if (capture.route === 'settings-appearance' && capture.underlyingRoute !== 'terminal') {
      errors.push(`settings underlying route drift: ${capture.caseId}`);
    }
  }
  return errors;
}
