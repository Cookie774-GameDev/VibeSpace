import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MONOCHROME_BASELINE_MANIFEST } from '../../../tests/visual/monochrome/baseline-manifest';
import { MONOCHROME_FIXTURE_MANIFEST } from '../../../tests/visual/monochrome/fixture-manifest';
import { MONOCHROME_ZOOM_ROWS } from '../../../tests/visual/monochrome/route-manifest';

type BrowserAuthorityCase = {
  readonly fixtureHash: string;
  readonly fixtureId: 'chat' | 'settings-appearance' | 'terminal-workbench';
  readonly id: string;
  readonly kind: string;
  readonly routeId: string | null;
};

const styleMetricsSource = readFileSync(
  resolve(process.cwd(), '../tests/visual/monochrome/styleMetrics.ts'),
  'utf8',
);
const fixtureManifestSource = readFileSync(
  resolve(process.cwd(), '../tests/visual/monochrome/fixture-manifest.ts'),
  'utf8',
);

function quotedValues(source: string, declaration: string): readonly string[] {
  const block = source.match(
    new RegExp(`const ${declaration} = [^\\[]*\\[([\\s\\S]*?)\\]\\s*(?:as const)?\\)?;`),
  )?.[1];
  if (!block) throw new Error(`missing ${declaration} authority`);
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const browserCaseIds = quotedValues(styleMetricsSource, 'BROWSER_CASE_IDS');
const terminalFixtureCaseIds = new Set(
  quotedValues(styleMetricsSource, 'TERMINAL_FIXTURE_CASE_IDS'),
);
const fixtureHashes = Object.freeze(
  Object.fromEntries(
    [...fixtureManifestSource.matchAll(/^\s*(?:'([^']+)'|([a-z-]+)):\s*'([0-9a-f]{64})',?$/gm)].map(
      (match) => [match[1] ?? match[2], match[3]],
    ),
  ),
) as Readonly<Record<string, string>>;
const BROWSER_CASES = Object.freeze(
  browserCaseIds.map((id) => {
    const fixtureId: BrowserAuthorityCase['fixtureId'] =
      id.startsWith('settings:') ||
      id.startsWith('access:') ||
      id === 'overlay:settings-modal-host' ||
      id === 'route:account'
        ? 'settings-appearance'
        : terminalFixtureCaseIds.has(id)
          ? 'terminal-workbench'
          : 'chat';
    const [kind, suffix] = id.split(':', 2);
    return Object.freeze({
      fixtureHash: fixtureHashes[fixtureId],
      fixtureId,
      id,
      kind,
      routeId: kind === 'route' ? suffix : null,
    });
  }),
) as readonly BrowserAuthorityCase[];

const BASELINE_REQUEST_AUTHORITY = Object.freeze([
  {
    caseId: 'default-chat',
    fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'default',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'default',
    surfaceId: 'baseline:default-chat',
  },
  {
    caseId: 'default-settings',
    fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'default',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'default',
    settingsTab: 'appearance',
    surfaceId: 'baseline:default-settings',
  },
  {
    caseId: 'default-terminal',
    fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'default',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'default',
    surfaceId: 'baseline:default-terminal',
  },
  {
    caseId: 'jarvis-chat',
    fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
    fixtureId: 'chat',
    origamiGate: false,
    pathname: '/chat',
    productTheme: 'jarvis',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'jarvis',
    surfaceId: 'baseline:jarvis-chat',
  },
  {
    caseId: 'jarvis-settings',
    fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'jarvis',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'jarvis',
    settingsTab: 'appearance',
    surfaceId: 'baseline:jarvis-settings',
  },
  {
    caseId: 'jarvis-terminal',
    fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'jarvis',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'jarvis',
    surfaceId: 'baseline:jarvis-terminal',
  },
  {
    caseId: 'origami-chat',
    fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
    fixtureId: 'chat',
    origamiGate: true,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'origami',
    surfaceId: 'baseline:origami-chat',
  },
  {
    caseId: 'vibespace-chat',
    fixtureHash: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
    fixtureId: 'chat',
    origamiGate: true,
    pathname: '/chat',
    productTheme: 'vibespace',
    requestedRoute: 'chat',
    requestedState: 'chat',
    requestedTheme: 'vibespace',
    surfaceId: 'baseline:vibespace-chat',
  },
  {
    caseId: 'vibespace-settings',
    fixtureHash: '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
    fixtureId: 'settings-appearance',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'vibespace',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'vibespace',
    settingsTab: 'appearance',
    surfaceId: 'baseline:vibespace-settings',
  },
  {
    caseId: 'vibespace-terminal',
    fixtureHash: 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
    fixtureId: 'terminal-workbench',
    origamiGate: false,
    pathname: '/terminal',
    productTheme: 'vibespace',
    requestedRoute: 'terminal',
    requestedState: 'terminal',
    requestedTheme: 'vibespace',
    surfaceId: 'baseline:vibespace-terminal',
  },
] as const);

function browserPathForEntry(entry: BrowserAuthorityCase): string {
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

function validateBrowserProjection(
  projected: readonly BrowserAuthorityCase[],
  authority: readonly BrowserAuthorityCase[],
): void {
  expect(projected).toHaveLength(authority.length);
  expect(projected).toEqual(authority);
  for (const entry of projected) {
    expect(Object.keys(entry).sort()).toEqual(
      ['fixtureHash', 'fixtureId', 'id', 'kind', 'routeId'].sort(),
    );
  }
}

import {
  MONOCHROME_VISUAL_TEST,
  MONOCHROME_APP_IDENTIFIER_ENV,
  MONOCHROME_CAPABILITY_IDENTIFIER_ENV,
  MONOCHROME_SESSION_NONCE_HASH_ENV,
  MONOCHROME_BASELINE_REQUEST_AUTHORITY,
  MONOCHROME_BROWSER_REQUEST_AUTHORITY,
  MONOCHROME_LEGACY_REQUEST_AUTHORITY,
  MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
  MONOCHROME_EVIDENCE_COMMIT_COMMAND,
  MONOCHROME_EVIDENCE_SCHEMA_VERSION,
  RUNTIME_PROFILE_ENV,
  createTauriMonochromeEvidenceCommit,
  createTauriRuntimeProfileQuery,
  parseMonochromeFixtureRequest,
  parseRuntimeProfile,
  parseRuntimeProfileHandshakeExpectation,
  resolveRuntimePlan,
  resolveRuntimeProfile,
  runtimePlan,
  verifyRuntimeProfileHandshake,
  type RuntimePlan,
  type MonochromeEvidenceCommitRequest,
  type RuntimeProfileEvidence,
  type RuntimeProfileQuery,
} from './runtimeProfile';

describe('parseRuntimeProfile (fail-closed compile-time parser)', () => {
  it('treats an absent signal as ordinary production', () => {
    expect(parseRuntimeProfile(undefined)).toMatchObject({
      kind: 'ordinary',
      isOrdinary: true,
      isVisualTest: false,
    });
    expect(parseRuntimeProfile(null)).toMatchObject({ kind: 'ordinary', isOrdinary: true });
  });

  it('rejects an empty compile-time value instead of treating it as absent', () => {
    expect(() => parseRuntimeProfile('')).toThrow(/VITE_VIBESPACE_RUNTIME_PROFILE/);
  });

  it('selects visual-test mode only for the exact named value', () => {
    expect(parseRuntimeProfile(MONOCHROME_VISUAL_TEST)).toMatchObject({
      kind: MONOCHROME_VISUAL_TEST,
      isOrdinary: false,
      isVisualTest: true,
    });
  });

  it('throws before React boot for every other non-empty value', () => {
    expect(() => parseRuntimeProfile('garbage')).toThrow(/VITE_VIBESPACE_RUNTIME_PROFILE/);
    expect(() => parseRuntimeProfile('MONOCHROME-VISUAL-TEST')).toThrow();
    expect(() => parseRuntimeProfile(' monochrome-visual-test')).toThrow();
    expect(() => parseRuntimeProfile('monochrome-visual-test ')).toThrow();
    expect(() => parseRuntimeProfile('xmonochrome-visual-test')).toThrow();
    expect(() => parseRuntimeProfile('monochrome-visual-testx')).toThrow();
    expect(() => parseRuntimeProfile('monochrome')).toThrow();
    expect(() => parseRuntimeProfile('dark')).toThrow();
  });

  it('never reflects invalid compile-time values into the categorical error', () => {
    const secret = 'token=super-secret\r\n\u001b[31mINJECTED';
    expect(() => parseRuntimeProfile(secret)).toThrow(
      `Invalid ${RUNTIME_PROFILE_ENV} runtime profile.`,
    );
    try {
      parseRuntimeProfile(secret);
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
      expect(String(error)).not.toContain('\r');
      expect(String(error)).not.toContain('\u001b');
      expect(String(error).length).toBeLessThan(100);
    }
  });

  it('exposes the frontend signal name, never the native signal', () => {
    expect(RUNTIME_PROFILE_ENV).toBe('VITE_VIBESPACE_RUNTIME_PROFILE');
    expect(RUNTIME_PROFILE_ENV).not.toBe('VIBESPACE_RUNTIME_PROFILE');
  });
});

const visualTestExpectation = Object.freeze({
  appIdentifier: 'ai.vibespace.monochrome.test0a1b2c3d',
  capabilityIdentifier: 'monochrome-test',
  sessionNonceHash: 'a'.repeat(64),
});
const deniedEffectCounters = Object.freeze({
  notification: 0,
  processRelaunch: 0,
  updater: 0,
  shellOpen: 0,
  externalHttp: 0,
  keychain: 0,
  registry: 0,
  launcher: 0,
  tray: 0,
  singleInstance: 0,
  globalShortcut: 0,
  deepLink: 0,
  autostart: 0,
});
const deniedEffects = Object.freeze({
  status: 'PASS' as const,
  manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
  counters: deniedEffectCounters,
});
const visualNativeEvidence = Object.freeze({
  profile: MONOCHROME_VISUAL_TEST,
  ...visualTestExpectation,
  deniedEffects,
});

describe('parseRuntimeProfileHandshakeExpectation', () => {
  it('requires no test-only identity values in ordinary mode', () => {
    expect(
      parseRuntimeProfileHandshakeExpectation(resolveRuntimePlan(undefined), {
        appIdentifier: undefined,
        capabilityIdentifier: undefined,
        sessionNonceHash: undefined,
      }),
    ).toBeUndefined();
  });

  it('rejects test-only identity values when the runtime profile is ordinary', () => {
    expect(() =>
      parseRuntimeProfileHandshakeExpectation(resolveRuntimePlan(undefined), visualTestExpectation),
    ).toThrow(/ordinary runtime profile/i);
  });

  it('accepts only the exact isolated visual-test identity shapes', () => {
    expect(
      parseRuntimeProfileHandshakeExpectation(
        resolveRuntimePlan(MONOCHROME_VISUAL_TEST),
        visualTestExpectation,
      ),
    ).toEqual(visualTestExpectation);
    expect(
      parseRuntimeProfileHandshakeExpectation(resolveRuntimePlan(MONOCHROME_VISUAL_TEST), {
        ...visualTestExpectation,
        appIdentifier: 'ai.vibespace.monochrome.testABC123',
      }),
    ).toMatchObject({ appIdentifier: 'ai.vibespace.monochrome.testABC123' });
  });

  it.each([
    [{ ...visualTestExpectation, appIdentifier: undefined }, MONOCHROME_APP_IDENTIFIER_ENV],
    [
      { ...visualTestExpectation, appIdentifier: 'ai.vibespace.production' },
      MONOCHROME_APP_IDENTIFIER_ENV,
    ],
    [
      { ...visualTestExpectation, capabilityIdentifier: undefined },
      MONOCHROME_CAPABILITY_IDENTIFIER_ENV,
    ],
    [
      { ...visualTestExpectation, capabilityIdentifier: 'default' },
      MONOCHROME_CAPABILITY_IDENTIFIER_ENV,
    ],
    [{ ...visualTestExpectation, sessionNonceHash: undefined }, MONOCHROME_SESSION_NONCE_HASH_ENV],
    [
      { ...visualTestExpectation, sessionNonceHash: 'A'.repeat(64) },
      MONOCHROME_SESSION_NONCE_HASH_ENV,
    ],
    [
      { ...visualTestExpectation, sessionNonceHash: 'a'.repeat(63) },
      MONOCHROME_SESSION_NONCE_HASH_ENV,
    ],
  ])('fails closed for missing or malformed test identity %#', (raw, expectedSignal) => {
    expect(() =>
      parseRuntimeProfileHandshakeExpectation(resolveRuntimePlan(MONOCHROME_VISUAL_TEST), raw),
    ).toThrow(expectedSignal);
  });
});

describe('runtimePlan (effect-host suppression flags)', () => {
  const ordinary = runtimePlan(parseRuntimeProfile(undefined));
  const visualTest = runtimePlan(parseRuntimeProfile(MONOCHROME_VISUAL_TEST));

  it('enables every effect host in ordinary mode', () => {
    expect(ordinary.isOrdinary).toBe(true);
    expect(ordinary.isVisualTest).toBe(false);
    for (const [key, value] of Object.entries(ordinary)) {
      if (key === 'profile' || key === 'isVisualTest') continue;
      expect(value, `ordinary.${key}`).toBe(true);
    }
  });

  it('disables every effect host in visual-test mode', () => {
    expect(visualTest.isVisualTest).toBe(true);
    expect(visualTest.isOrdinary).toBe(false);
    for (const [key, value] of Object.entries(visualTest)) {
      if (key === 'profile' || key === 'isOrdinary' || key === 'isVisualTest') continue;
      expect(value, `visualTest.${key}`).toBe(false);
    }
  });

  it('derives a stable plan from an injectable raw value', () => {
    expect(resolveRuntimePlan(undefined).isOrdinary).toBe(true);
    expect(resolveRuntimePlan(MONOCHROME_VISUAL_TEST).isVisualTest).toBe(true);
    expect(() => resolveRuntimePlan('nope')).toThrow();
    expect(resolveRuntimeProfile(undefined).kind).toBe('ordinary');
  });
});

describe('parseMonochromeFixtureRequest', () => {
  const visualPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);
  const chatHash = 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9';

  function query(overrides: Record<string, string> = {}) {
    return new URLSearchParams({
      'monochrome-fixture': 'chat',
      'monochrome-fixture-hash': chatHash,
      'monochrome-surface': 'route:chat',
      'monochrome-theme': 'monochrome',
      'monochrome-origami-gate': 'false',
      ...overrides,
    });
  }

  it('validates and consumes the complete visual fixture request', () => {
    expect(parseMonochromeFixtureRequest(visualPlan, query(), '/chat')).toEqual({
      fixtureId: 'chat',
      fixtureHash: chatHash,
      surfaceId: 'route:chat',
      requestedTheme: 'monochrome',
      productTheme: 'monochrome',
      origamiGate: false,
      requestedRoute: 'chat',
      authorityId: 'route:chat',
    });
  });

  it('resolves the origami replay pseudo-theme to the product vibespace theme', () => {
    expect(
      parseMonochromeFixtureRequest(
        visualPlan,
        query({ 'monochrome-theme': 'origami', 'monochrome-origami-gate': 'true' }),
        '/chat',
      ),
    ).toMatchObject({ requestedTheme: 'origami', productTheme: 'vibespace', origamiGate: true });
  });

  it('preserves a validated terminal route under the settings Appearance overlay', () => {
    expect(
      parseMonochromeFixtureRequest(
        visualPlan,
        query({
          'monochrome-fixture': 'settings-appearance',
          'monochrome-fixture-hash':
            '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
          'monochrome-surface': 'state:modal-open-monochrome',
          'monochrome-state': 'settings-appearance',
        }),
        '/terminal',
      ),
    ).toMatchObject({ requestedRoute: 'terminal', requestedState: 'settings-appearance' });
    expect(() => parseMonochromeFixtureRequest(visualPlan, query(), '/invalid-route')).toThrow(
      /fixture request invalid/i,
    );
  });

  it.each([
    'about',
    'accessibility',
    'admin',
    'allaboutme',
    'ambient',
    'appearance',
    'composerstt',
    'connections',
    'hive',
    'hotkeys',
    'jarvisactions',
    'localmodels',
    'notifications',
    'phone',
    'plans',
    'plugins',
    'providers',
    'voice',
  ] as const)('parses the exact /settings/%s tab over the deliberate chat route', (tab) => {
    expect(
      parseMonochromeFixtureRequest(
        visualPlan,
        query({
          'monochrome-fixture': 'settings-appearance',
          'monochrome-fixture-hash':
            '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
          'monochrome-surface': `settings:${tab}`,
        }),
        `/settings/${tab}`,
      ),
    ).toMatchObject({
      requestedRoute: 'chat',
      settingsTab: tab,
    });
  });

  it.each(['/settings', '/settings/', '/settings/not-a-tab', '/settings/appearance/extra'])(
    'rejects invalid settings pathname %s',
    (pathname) => {
      expect(() =>
        parseMonochromeFixtureRequest(
          visualPlan,
          query({
            'monochrome-fixture': 'settings-appearance',
            'monochrome-fixture-hash':
              '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
            'monochrome-state': 'settings-appearance',
          }),
          pathname,
        ),
      ).toThrow(/fixture request invalid/i);
    },
  );

  it.each([
    ['monochrome-fixture', 'unknown'],
    ['monochrome-fixture-hash', '0'.repeat(64)],
    ['monochrome-surface', ''],
    ['monochrome-surface', 'bad value'],
    ['monochrome-theme', 'dark'],
    ['monochrome-origami-gate', 'TRUE'],
  ])('fails closed for malformed %s', (key, value) => {
    expect(() => parseMonochromeFixtureRequest(visualPlan, query({ [key]: value }))).toThrow(
      /fixture request invalid/i,
    );
  });

  it('requires the origami gate only with the origami pseudo-theme', () => {
    expect(() =>
      parseMonochromeFixtureRequest(visualPlan, query({ 'monochrome-origami-gate': 'true' })),
    ).toThrow(/fixture request invalid/i);
    expect(() =>
      parseMonochromeFixtureRequest(visualPlan, query({ 'monochrome-theme': 'origami' })),
    ).toThrow(/fixture request invalid/i);
  });

  it('rejects duplicate and unknown monochrome parameters as unconsumed input', () => {
    const duplicate = query();
    duplicate.append('monochrome-surface', 'route:other');
    expect(() => parseMonochromeFixtureRequest(visualPlan, duplicate)).toThrow(
      /fixture request invalid/i,
    );
    const unknown = query();
    unknown.set('monochrome-secret', 'marker');
    expect(() => parseMonochromeFixtureRequest(visualPlan, unknown)).toThrow(
      /fixture request invalid/i,
    );
  });

  it('rejects every test-only fixture parameter in ordinary mode', () => {
    expect(() => parseMonochromeFixtureRequest(resolveRuntimePlan(undefined), query())).toThrow(
      /ordinary runtime/i,
    );
    expect(
      parseMonochromeFixtureRequest(resolveRuntimePlan(undefined), new URLSearchParams()),
    ).toBeUndefined();
  });
});

describe('exact 78-row browser request authority', () => {
  const authorityVisualPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);
  it('matches every full authority object, not only IDs', () => {
    expect(BROWSER_CASES).toHaveLength(78);
    expect(() =>
      validateBrowserProjection(MONOCHROME_BROWSER_REQUEST_AUTHORITY, BROWSER_CASES),
    ).not.toThrow();
  });

  it.each(BROWSER_CASES)('accepts only the exact authority tuple for $id', (entry) => {
    const requestUrl = new URL(browserPathForEntry(entry), 'http://127.0.0.1');
    requestUrl.searchParams.set('monochrome-fixture', entry.fixtureId);
    requestUrl.searchParams.set('monochrome-fixture-hash', entry.fixtureHash);
    requestUrl.searchParams.set('monochrome-surface', entry.id);
    requestUrl.searchParams.set('monochrome-theme', 'monochrome');
    requestUrl.searchParams.set('monochrome-origami-gate', 'false');
    expect(
      parseMonochromeFixtureRequest(
        authorityVisualPlan,
        requestUrl.searchParams,
        requestUrl.pathname,
      ),
    ).toMatchObject({
      authorityId: entry.id,
      fixtureId: entry.fixtureId,
      fixtureHash: entry.fixtureHash,
    });
  });

  it('rejects cross-row path, state, fixture, and hash drift', () => {
    const entry = BROWSER_CASES.find(({ id }) => id === 'overlay:actions-palette-host')!;
    const requestUrl = new URL(browserPathForEntry(entry), 'http://127.0.0.1');
    requestUrl.searchParams.set('monochrome-fixture', entry.fixtureId);
    requestUrl.searchParams.set('monochrome-fixture-hash', entry.fixtureHash);
    requestUrl.searchParams.set('monochrome-surface', entry.id);
    requestUrl.searchParams.set('monochrome-theme', 'monochrome');
    requestUrl.searchParams.set('monochrome-origami-gate', 'false');
    for (const mutate of [
      (url: URL) => {
        url.pathname = '/agents';
      },
      (url: URL) => {
        url.searchParams.set('monochrome-state', 'overlay:call-modal');
      },
      (url: URL) => {
        url.searchParams.set('monochrome-fixture', 'terminal-workbench');
      },
      (url: URL) => {
        url.searchParams.set('monochrome-fixture-hash', '0'.repeat(64));
      },
      (url: URL) => {
        url.searchParams.set('monochrome-surface', `${entry.id}-extra`);
      },
    ]) {
      const drifted = new URL(requestUrl);
      mutate(drifted);
      expect(() =>
        parseMonochromeFixtureRequest(authorityVisualPlan, drifted.searchParams, drifted.pathname),
      ).toThrow(/fixture request invalid/i);
    }
  });
});

describe('exact ten-row preserved-theme B0 request authority', () => {
  const baselineVisualPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);

  function requestFor(entry: (typeof BASELINE_REQUEST_AUTHORITY)[number]): URL {
    const request = new URL(entry.pathname, 'http://127.0.0.1');
    request.searchParams.set('monochrome-fixture', entry.fixtureId);
    request.searchParams.set('monochrome-fixture-hash', entry.fixtureHash);
    request.searchParams.set('monochrome-surface', entry.surfaceId);
    request.searchParams.set('monochrome-theme', entry.requestedTheme);
    request.searchParams.set('monochrome-origami-gate', String(entry.origamiGate));
    request.searchParams.set('monochrome-state', entry.requestedState);
    return request;
  }

  it('exports the literal ten tuples and remains bound to immutable baseline and fixture authority', () => {
    expect(MONOCHROME_BROWSER_REQUEST_AUTHORITY).toHaveLength(78);
    expect(MONOCHROME_BASELINE_REQUEST_AUTHORITY).toEqual(BASELINE_REQUEST_AUTHORITY);
    expect(MONOCHROME_BASELINE_MANIFEST.captures.map(({ caseId }) => caseId)).toEqual(
      BASELINE_REQUEST_AUTHORITY.map(({ caseId }) => caseId),
    );
    for (const entry of BASELINE_REQUEST_AUTHORITY) {
      const capture = MONOCHROME_BASELINE_MANIFEST.captures.find(
        ({ caseId }) => caseId === entry.caseId,
      );
      expect(capture).toBeDefined();
      expect(capture?.fixtureId).toBe(entry.fixtureId);
      expect(capture?.origamiGateActive).toBe(entry.origamiGate);
      expect(MONOCHROME_FIXTURE_MANIFEST.fixtureHashes[entry.fixtureId]).toBe(entry.fixtureHash);
      const productionEntry = MONOCHROME_BASELINE_REQUEST_AUTHORITY.find(
        ({ caseId }) => caseId === entry.caseId,
      );
      expect(Object.isFrozen(productionEntry)).toBe(true);
    }
    expect(Object.isFrozen(MONOCHROME_BASELINE_REQUEST_AUTHORITY)).toBe(true);
  });

  it.each(BASELINE_REQUEST_AUTHORITY)(
    'accepts only the literal preserved-theme tuple for $caseId',
    (entry) => {
      const request = requestFor(entry);
      expect(
        parseMonochromeFixtureRequest(baselineVisualPlan, request.searchParams, request.pathname),
      ).toEqual({
        authorityId: entry.surfaceId,
        fixtureHash: entry.fixtureHash,
        fixtureId: entry.fixtureId,
        origamiGate: entry.origamiGate,
        productTheme: entry.productTheme,
        requestedRoute: entry.requestedRoute,
        requestedState: entry.requestedState,
        requestedTheme: entry.requestedTheme,
        ...('settingsTab' in entry ? { settingsTab: entry.settingsTab } : {}),
        surfaceId: entry.surfaceId,
      });
    },
  );

  it('rejects every one-field baseline tuple mutation and never guesses a suffix', () => {
    const defaultChat = BASELINE_REQUEST_AUTHORITY[0];
    const exact = requestFor(defaultChat);
    const mutations: Array<(request: URL) => void> = [
      (request) => {
        request.pathname = '/terminal';
      },
      (request) => {
        request.searchParams.delete('monochrome-state');
      },
      (request) => {
        request.searchParams.set('monochrome-state', 'terminal');
      },
      (request) => {
        request.searchParams.set('monochrome-fixture', 'terminal-workbench');
      },
      (request) => {
        request.searchParams.set('monochrome-fixture-hash', '0'.repeat(64));
      },
      (request) => {
        request.searchParams.set('monochrome-surface', 'baseline:jarvis-chat');
      },
      (request) => {
        request.searchParams.set('monochrome-theme', 'jarvis');
      },
      (request) => {
        request.searchParams.set('monochrome-origami-gate', 'true');
      },
    ];
    for (const mutate of mutations) {
      const drifted = new URL(exact);
      mutate(drifted);
      expect(() =>
        parseMonochromeFixtureRequest(baselineVisualPlan, drifted.searchParams, drifted.pathname),
      ).toThrow(/fixture request invalid/i);
    }

    const vibespaceChat = requestFor(BASELINE_REQUEST_AUTHORITY[7]);
    vibespaceChat.searchParams.set('monochrome-origami-gate', 'false');
    expect(() =>
      parseMonochromeFixtureRequest(
        baselineVisualPlan,
        vibespaceChat.searchParams,
        vibespaceChat.pathname,
      ),
    ).toThrow(/fixture request invalid/i);

    for (const surfaceId of [
      'baseline:unknown',
      'baseline:default-chat-extra',
      'baseline:synthetic-chat',
    ]) {
      const unknown = new URL(exact);
      unknown.searchParams.set('monochrome-surface', surfaceId);
      expect(() =>
        parseMonochromeFixtureRequest(baselineVisualPlan, unknown.searchParams, unknown.pathname),
      ).toThrow(/fixture request invalid/i);
    }
  });

  it('rejects additive browser-location input on an otherwise exact baseline tuple', () => {
    const request = requestFor(BASELINE_REQUEST_AUTHORITY[0]);
    request.searchParams.set('view', 'dictation');
    expect(() =>
      parseMonochromeFixtureRequest(baselineVisualPlan, request.searchParams, request.pathname),
    ).toThrow(/fixture request invalid/i);
  });
});

type SupplementaryAuthorityCase = {
  readonly fixtureId: 'chat' | 'settings-appearance' | 'terminal-workbench';
  readonly locationQuery?: Readonly<Record<string, string>>;
  readonly origamiGate?: boolean;
  readonly pathname: string;
  readonly requestedRoute: string;
  readonly requestedState?: string;
  readonly requestedTheme?: 'monochrome' | 'default' | 'vibespace' | 'jarvis' | 'origami';
  readonly settingsTab?: string;
  readonly surfaceId: string;
};

const SUPPLEMENTARY_NAMED_CASES = Object.freeze([
  {
    surfaceId: 'a11y:text-contrast',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
  },
  {
    surfaceId: 'a11y:non-text-contrast',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
  },
  {
    surfaceId: 'a11y:pointer-targets',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
  },
  { surfaceId: 'a11y:forced-colors', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  {
    surfaceId: 'a11y:production-navigation',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
  },
  { surfaceId: 'spatial:canvas', pathname: '/canvas', fixtureId: 'chat', requestedRoute: 'canvas' },
  {
    surfaceId: 'spatial:context',
    pathname: '/context',
    fixtureId: 'terminal-workbench',
    requestedRoute: 'context',
  },
  {
    surfaceId: 'theme:default',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedTheme: 'default',
  },
  {
    surfaceId: 'theme:jarvis',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedTheme: 'jarvis',
  },
  { surfaceId: 'theme:monochrome', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  {
    surfaceId: 'theme:origami',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedTheme: 'origami',
    origamiGate: true,
  },
  {
    surfaceId: 'theme:vibespace',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedTheme: 'vibespace',
  },
  { surfaceId: 'zoom:50%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  { surfaceId: 'zoom:80%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  { surfaceId: 'zoom:100%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  { surfaceId: 'zoom:125%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  { surfaceId: 'zoom:150%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  { surfaceId: 'zoom:200%', pathname: '/chat', fixtureId: 'chat', requestedRoute: 'chat' },
  {
    surfaceId: 'state:usage',
    pathname: '/account',
    fixtureId: 'settings-appearance',
    locationQuery: Object.freeze({ tab: 'usage' }),
    requestedRoute: 'account',
    requestedState: 'usage',
  },
  {
    surfaceId: 'state:billing-plans',
    pathname: '/settings/plans',
    fixtureId: 'settings-appearance',
    requestedRoute: 'chat',
    requestedState: 'billing',
    settingsTab: 'plans',
  },
  {
    surfaceId: 'state:dropdown-open',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'dropdown-open',
  },
  {
    surfaceId: 'state:tooltip-visible',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'tooltip-visible',
  },
  {
    surfaceId: 'state:empty-state',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'empty',
  },
  {
    surfaceId: 'state:modal-open',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'modal-open',
  },
  {
    surfaceId: 'state:toast-visible',
    pathname: '/chat',
    fixtureId: 'chat',
    requestedRoute: 'chat',
    requestedState: 'toast-visible',
  },
  {
    surfaceId: 'state:locked-access',
    pathname: '/account',
    fixtureId: 'settings-appearance',
    requestedRoute: 'account',
    requestedState: 'locked',
  },
  {
    surfaceId: 'state:modal-open-default',
    pathname: '/terminal',
    fixtureId: 'settings-appearance',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'default',
    settingsTab: 'appearance',
  },
  {
    surfaceId: 'state:modal-open-jarvis',
    pathname: '/terminal',
    fixtureId: 'settings-appearance',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'jarvis',
    settingsTab: 'appearance',
  },
  {
    surfaceId: 'state:modal-open-monochrome',
    pathname: '/terminal',
    fixtureId: 'settings-appearance',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    settingsTab: 'appearance',
  },
  {
    surfaceId: 'state:modal-open-vibespace',
    pathname: '/terminal',
    fixtureId: 'settings-appearance',
    requestedRoute: 'terminal',
    requestedState: 'settings-appearance',
    requestedTheme: 'vibespace',
    settingsTab: 'appearance',
  },
] as const satisfies readonly SupplementaryAuthorityCase[]);

const SUPPLEMENTARY_ROUTE_CASES = Object.freeze(
  BROWSER_CASES.filter(
    (entry): entry is BrowserAuthorityCase & { routeId: string } =>
      entry.kind === 'route' && entry.routeId !== null,
  ).map((entry) =>
    Object.freeze({
      fixtureId: entry.fixtureId,
      pathname: `/${entry.routeId}`,
      requestedRoute: entry.routeId,
      surfaceId: `a11y:route:${entry.routeId}`,
    }),
  ),
) satisfies readonly SupplementaryAuthorityCase[];

const SUPPLEMENTARY_AUTHORITY_CASES: readonly SupplementaryAuthorityCase[] = Object.freeze([
  ...SUPPLEMENTARY_NAMED_CASES,
  ...SUPPLEMENTARY_ROUTE_CASES,
]);

describe('exact supplementary request authority', () => {
  const visualPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);

  function requestFor(entry: SupplementaryAuthorityCase): URL {
    const requestedTheme = entry.requestedTheme ?? 'monochrome';
    const request = new URL(entry.pathname, 'http://127.0.0.1');
    request.searchParams.set('monochrome-fixture', entry.fixtureId);
    request.searchParams.set('monochrome-fixture-hash', fixtureHashes[entry.fixtureId]);
    request.searchParams.set('monochrome-surface', entry.surfaceId);
    request.searchParams.set('monochrome-theme', requestedTheme);
    request.searchParams.set('monochrome-origami-gate', String(entry.origamiGate ?? false));
    if (entry.requestedState !== undefined) {
      request.searchParams.set('monochrome-state', entry.requestedState);
    }
    for (const [key, value] of Object.entries(entry.locationQuery ?? {})) {
      request.searchParams.set(key, value);
    }
    return request;
  }

  it('covers five a11y, two spatial, five theme, six zoom, eight named-state, four retained overlay, and eighteen route rows', () => {
    expect(SUPPLEMENTARY_NAMED_CASES).toHaveLength(30);
    expect(SUPPLEMENTARY_ROUTE_CASES).toHaveLength(18);
    expect(MONOCHROME_LEGACY_REQUEST_AUTHORITY).toHaveLength(48);
    expect(MONOCHROME_BROWSER_REQUEST_AUTHORITY).toHaveLength(78);
    expect(
      new Set(MONOCHROME_LEGACY_REQUEST_AUTHORITY.map(({ surfaceId }) => surfaceId)).size,
    ).toBe(48);
    expect(Object.isFrozen(MONOCHROME_LEGACY_REQUEST_AUTHORITY)).toBe(true);
    expect(MONOCHROME_LEGACY_REQUEST_AUTHORITY.every(Object.isFrozen)).toBe(true);
  });

  it.each(SUPPLEMENTARY_AUTHORITY_CASES)('accepts the exact tuple for $surfaceId', (entry) => {
    const request = requestFor(entry);
    const requestedTheme = entry.requestedTheme ?? 'monochrome';
    expect(
      parseMonochromeFixtureRequest(visualPlan, request.searchParams, request.pathname),
    ).toEqual({
      authorityId: entry.surfaceId,
      fixtureHash: fixtureHashes[entry.fixtureId],
      fixtureId: entry.fixtureId,
      origamiGate: entry.origamiGate ?? false,
      productTheme: requestedTheme === 'origami' ? 'vibespace' : requestedTheme,
      requestedRoute: entry.requestedRoute,
      ...(entry.requestedState === undefined ? {} : { requestedState: entry.requestedState }),
      requestedTheme,
      ...(entry.settingsTab === undefined ? {} : { settingsTab: entry.settingsTab }),
      surfaceId: entry.surfaceId,
    });
  });

  it('rejects representative one-field drift and unknown suffixes', () => {
    const exact = requestFor(SUPPLEMENTARY_NAMED_CASES[0]);
    const mutations: Array<(request: URL) => void> = [
      (request) => {
        request.pathname = '/terminal';
      },
      (request) => {
        request.searchParams.delete('monochrome-state');
      },
      (request) => {
        request.searchParams.set('monochrome-fixture', 'terminal-workbench');
      },
      (request) => {
        request.searchParams.set('monochrome-fixture-hash', '0'.repeat(64));
      },
      (request) => {
        request.searchParams.set('monochrome-theme', 'default');
      },
      (request) => {
        request.searchParams.set('monochrome-origami-gate', 'true');
      },
      (request) => {
        request.searchParams.set('monochrome-surface', 'a11y:text-contrast-extra');
      },
    ];
    for (const mutate of mutations) {
      const drifted = new URL(exact);
      mutate(drifted);
      expect(() =>
        parseMonochromeFixtureRequest(visualPlan, drifted.searchParams, drifted.pathname),
      ).toThrow(/fixture request invalid/i);
    }
  });

  it('rejects missing, duplicate, and drifted usage location authority', () => {
    const entry = SUPPLEMENTARY_NAMED_CASES.find(
      (candidate) => candidate.surfaceId === 'state:usage',
    )!;
    const mutations: Array<(request: URL) => void> = [
      (request) => {
        request.searchParams.delete('tab');
      },
      (request) => {
        request.searchParams.append('tab', 'usage');
      },
      (request) => {
        request.searchParams.set('tab', 'profile');
      },
    ];
    for (const mutate of mutations) {
      const drifted = requestFor(entry);
      mutate(drifted);
      expect(() =>
        parseMonochromeFixtureRequest(visualPlan, drifted.searchParams, drifted.pathname),
      ).toThrow(/fixture request invalid/i);
    }
  });

  it.each([
    ['workbench', '1'],
    ['monochrome-workbench', '1'],
    ['untrusted-location', 'detached'],
  ])('rejects additive %s input on an otherwise exact supplementary tuple', (key, value) => {
    const request = requestFor(SUPPLEMENTARY_NAMED_CASES[0]);
    request.searchParams.set(key, value);
    expect(() =>
      parseMonochromeFixtureRequest(visualPlan, request.searchParams, request.pathname),
    ).toThrow(/fixture request invalid/i);
  });

  it('accepts the exact plan-required zoom:150% authority row', () => {
    const entry = SUPPLEMENTARY_NAMED_CASES.find(
      (candidate) => candidate.surfaceId === 'zoom:150%',
    )!;
    const request = requestFor(entry);
    expect(
      parseMonochromeFixtureRequest(visualPlan, request.searchParams, request.pathname),
    ).toMatchObject({
      authorityId: 'zoom:150%',
      fixtureId: 'chat',
      origamiGate: false,
      productTheme: 'monochrome',
      requestedRoute: 'chat',
      requestedTheme: 'monochrome',
      surfaceId: 'zoom:150%',
    });
  });

  it('keeps every canonical route zoom row backed by one exact runtime authority tuple', () => {
    for (const { surfaceId } of MONOCHROME_ZOOM_ROWS) {
      expect(
        MONOCHROME_LEGACY_REQUEST_AUTHORITY.filter(
          (authority) => authority.surfaceId === surfaceId,
        ),
      ).toEqual([
        {
          fixtureHash: fixtureHashes.chat,
          fixtureId: 'chat',
          origamiGate: false,
          pathname: '/chat',
          productTheme: 'monochrome',
          requestedRoute: 'chat',
          requestedTheme: 'monochrome',
          surfaceId,
        },
      ]);
    }
  });

  it.each(['zoom:50%', 'zoom:80%', 'zoom:150%'] as const)(
    'rejects every one-field and additive-key variant of %s',
    (surfaceId) => {
      const entry = SUPPLEMENTARY_NAMED_CASES.find(
        (candidate) => candidate.surfaceId === surfaceId,
      )!;
      const mutations: Array<(request: URL) => void> = [
        (request) => {
          request.pathname = '/terminal';
        },
        (request) => {
          request.searchParams.set('monochrome-fixture', 'terminal-workbench');
        },
        (request) => {
          request.searchParams.set('monochrome-fixture-hash', '0'.repeat(64));
        },
        (request) => {
          request.searchParams.set('monochrome-surface', 'zoom:51%');
        },
        (request) => {
          request.searchParams.set('monochrome-theme', 'default');
        },
        (request) => {
          request.searchParams.set('monochrome-origami-gate', 'true');
        },
        (request) => {
          request.searchParams.set('monochrome-state', 'zoomed');
        },
        (request) => {
          request.searchParams.set('view', 'dictation');
        },
      ];
      for (const mutate of mutations) {
        const drifted = requestFor(entry);
        mutate(drifted);
        expect(() =>
          parseMonochromeFixtureRequest(visualPlan, drifted.searchParams, drifted.pathname),
        ).toThrow(/fixture request invalid/i);
      }
    },
  );
});

describe('verifyRuntimeProfileHandshake (frontend/native agreement)', () => {
  const ordinaryPlan = resolveRuntimePlan(undefined);
  const visualTestPlan = resolveRuntimePlan(MONOCHROME_VISUAL_TEST);

  function queryReturning(evidence: unknown): RuntimeProfileQuery {
    return vi.fn(async (): Promise<RuntimeProfileEvidence> => evidence as RuntimeProfileEvidence);
  }

  it('succeeds when ordinary frontend and native agree', async () => {
    const query = queryReturning({
      profile: 'ordinary',
      appIdentifier: 'ai.jarvis.desktop',
      capabilityIdentifier: null,
      sessionNonceHash: null,
    });
    await expect(verifyRuntimeProfileHandshake(query, ordinaryPlan)).resolves.toMatchObject({
      profile: 'ordinary',
    });
    expect(query).toHaveBeenCalledWith('runtime_profile_query');
  });

  it.each(['ai.vibespace', 'ai.jarvis.desktop.preview', 'com.example.desktop', ''])(
    'rejects non-canonical ordinary app identifier %j',
    async (appIdentifier) => {
      await expect(
        verifyRuntimeProfileHandshake(
          queryReturning({
            profile: 'ordinary',
            appIdentifier,
            capabilityIdentifier: null,
            sessionNonceHash: null,
          }),
          ordinaryPlan,
        ),
      ).rejects.toThrow(/ordinary identity invalid/i);
    },
  );

  it('succeeds when visual-test frontend and native agree', async () => {
    const query = queryReturning(visualNativeEvidence);
    await expect(
      verifyRuntimeProfileHandshake(query, visualTestPlan, visualTestExpectation),
    ).resolves.toEqual(visualNativeEvidence);
  });

  it('fails closed when the native profile mismatches the frontend', async () => {
    await expect(
      verifyRuntimeProfileHandshake(
        queryReturning({ profile: 'ordinary', ...visualTestExpectation }),
        visualTestPlan,
        visualTestExpectation,
      ),
    ).rejects.toThrow(/handshake failed/i);
    await expect(
      verifyRuntimeProfileHandshake(queryReturning(visualNativeEvidence), ordinaryPlan),
    ).rejects.toThrow(/handshake failed/i);
  });

  it('fails closed when the native query is unavailable', async () => {
    const secret = 'token=super-secret\r\n\u001b[31mINJECTED';
    const query = vi.fn(async () => {
      throw new Error(secret);
    });
    const result = verifyRuntimeProfileHandshake(query, ordinaryPlan);
    await expect(result).rejects.toThrow(
      'Runtime profile handshake failed: native query unavailable',
    );
    await result.catch((error) => {
      expect(String(error)).not.toContain('super-secret');
      expect(String(error)).not.toContain('\r');
      expect(String(error)).not.toContain('\u001b');
      expect(String(error).length).toBeLessThan(120);
    });
  });

  it('fails closed when the native evidence is missing or malformed', async () => {
    await expect(
      verifyRuntimeProfileHandshake(queryReturning(undefined), ordinaryPlan),
    ).rejects.toThrow(/missing/i);
    await expect(
      verifyRuntimeProfileHandshake(
        queryReturning({
          profile: '',
          appIdentifier: '',
          capabilityIdentifier: '',
          sessionNonceHash: '',
        }),
        ordinaryPlan,
      ),
    ).rejects.toThrow(/missing/i);
  });

  it.each([
    ['appIdentifier', 'ai.vibespace.monochrome.testdeadbeef'],
    ['capabilityIdentifier', 'default'],
    ['sessionNonceHash', 'b'.repeat(64)],
  ] as const)(
    'fails closed when native %s mismatches the frontend expectation',
    async (field, value) => {
      await expect(
        verifyRuntimeProfileHandshake(
          queryReturning({
            ...visualNativeEvidence,
            [field]: value,
          }),
          visualTestPlan,
          visualTestExpectation,
        ),
      ).rejects.toThrow(/handshake failed/i);
    },
  );

  it.each([
    {
      profile: 'ordinary',
      appIdentifier: 'ai.vibespace.monochrome.testdeadbeef',
      capabilityIdentifier: null,
      sessionNonceHash: null,
    },
    {
      profile: 'ordinary',
      appIdentifier: 'ai.vibespace.monochrome.test-canary',
      capabilityIdentifier: null,
      sessionNonceHash: null,
    },
    {
      profile: 'ordinary',
      appIdentifier: 'ai.vibespace',
      capabilityIdentifier: 'monochrome-test',
      sessionNonceHash: null,
    },
    {
      profile: 'ordinary',
      appIdentifier: 'ai.vibespace',
      capabilityIdentifier: null,
      sessionNonceHash: 'b'.repeat(64),
    },
  ])('rejects test-session evidence in ordinary mode', async (evidence) => {
    await expect(
      verifyRuntimeProfileHandshake(queryReturning(evidence), ordinaryPlan),
    ).rejects.toThrow(/ordinary identity invalid/i);
  });

  it('times out a query that never settles', async () => {
    vi.useFakeTimers();
    const query = vi.fn(() => new Promise<RuntimeProfileEvidence>(() => undefined));
    const result = verifyRuntimeProfileHandshake(query, ordinaryPlan, undefined, 25);
    const assertion = expect(result).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    vi.useRealTimers();
  });

  it('allows a bounded delayed native query during a busy cold-start window', async () => {
    vi.useFakeTimers();
    const query = vi.fn(
      () =>
        new Promise<RuntimeProfileEvidence>((resolve) => {
          setTimeout(
            () =>
              resolve({
                profile: 'ordinary',
                appIdentifier: 'ai.jarvis.desktop',
                capabilityIdentifier: null,
                sessionNonceHash: null,
              }),
            15_000,
          );
        }),
    );
    const result = verifyRuntimeProfileHandshake(query, ordinaryPlan);
    const assertion = expect(result).resolves.toMatchObject({ profile: 'ordinary' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    vi.useRealTimers();
  });

  it('fails closed before querying when the visual-test identity expectation is absent', async () => {
    const query = queryReturning(visualNativeEvidence);
    await expect(verifyRuntimeProfileHandshake(query, visualTestPlan)).rejects.toThrow(
      /expectation/i,
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('createTauriRuntimeProfileQuery (narrow typed adapter)', () => {
  it('invokes the exact runtime_profile_query command and validates ordinary evidence', async () => {
    const invoke = vi.fn(async (cmd: string) => ({
      profile: cmd === 'runtime_profile_query' ? 'ordinary' : 'x',
      appIdentifier: 'ai.jarvis.desktop',
      capabilityIdentifier: null,
      sessionNonceHash: null,
    }));
    const query = createTauriRuntimeProfileQuery(invoke);
    const evidence = await query('runtime_profile_query');
    expect(invoke).toHaveBeenCalledWith('runtime_profile_query');
    expect(evidence.profile).toBe('ordinary');
  });

  it.each([
    ['PASS', deniedEffectCounters],
    ['FAIL', { ...deniedEffectCounters, shellOpen: 2 }],
  ] as const)(
    'validates visual evidence with a %s denied-effect snapshot',
    async (status, counters) => {
      const evidence = {
        profile: MONOCHROME_VISUAL_TEST,
        ...visualTestExpectation,
        deniedEffects: {
          status,
          manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
          counters,
        },
      };
      const query = createTauriRuntimeProfileQuery(vi.fn(async () => evidence));
      await expect(query('runtime_profile_query')).resolves.toEqual(evidence);
    },
  );

  it.each([
    ['unknown root key', { ...visualNativeEvidence, extra: true }],
    [
      'missing visual snapshot',
      {
        profile: MONOCHROME_VISUAL_TEST,
        ...visualTestExpectation,
      },
    ],
    [
      'ordinary snapshot injection',
      {
        profile: 'ordinary',
        appIdentifier: 'ai.jarvis.desktop',
        capabilityIdentifier: null,
        sessionNonceHash: null,
        deniedEffects,
      },
    ],
    [
      'wrong manifest',
      {
        ...visualNativeEvidence,
        deniedEffects: { ...deniedEffects, manifestHash: '0'.repeat(64) },
      },
    ],
    [
      'wrong status',
      { ...visualNativeEvidence, deniedEffects: { ...deniedEffects, status: 'READY' } },
    ],
    [
      'missing counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: Object.fromEntries(
            Object.entries(deniedEffectCounters).filter(([key]) => key !== 'autostart'),
          ),
        },
      },
    ],
    [
      'extra counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, filesystemWrite: 0 },
        },
      },
    ],
    [
      'reordered counters',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: {
            processRelaunch: 0,
            notification: 0,
            updater: 0,
            shellOpen: 0,
            externalHttp: 0,
            keychain: 0,
            registry: 0,
            launcher: 0,
            tray: 0,
            singleInstance: 0,
            globalShortcut: 0,
            deepLink: 0,
            autostart: 0,
          },
        },
      },
    ],
    [
      'reordered root',
      {
        appIdentifier: visualTestExpectation.appIdentifier,
        profile: MONOCHROME_VISUAL_TEST,
        capabilityIdentifier: visualTestExpectation.capabilityIdentifier,
        sessionNonceHash: visualTestExpectation.sessionNonceHash,
        deniedEffects,
      },
    ],
    [
      'reordered snapshot',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          manifestHash: MONOCHROME_DENIED_EFFECT_MANIFEST_HASH,
          status: 'PASS',
          counters: deniedEffectCounters,
        },
      },
    ],
    [
      'extra snapshot key',
      {
        ...visualNativeEvidence,
        deniedEffects: { ...deniedEffects, source: 'renderer' },
      },
    ],
    [
      'non-safe counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, notification: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
    ],
    [
      'negative counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, notification: -1 },
        },
      },
    ],
    [
      'fractional counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, notification: 0.5 },
        },
      },
    ],
    [
      'non-finite counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, notification: Number.NaN },
        },
      },
    ],
    [
      'infinite counter',
      {
        ...visualNativeEvidence,
        deniedEffects: {
          ...deniedEffects,
          counters: { ...deniedEffectCounters, notification: Number.POSITIVE_INFINITY },
        },
      },
    ],
  ])('rejects %s', async (_label, evidence) => {
    const query = createTauriRuntimeProfileQuery(vi.fn(async () => evidence));
    await expect(query('runtime_profile_query')).rejects.toThrow(/native evidence invalid/i);
  });
});

describe('createTauriMonochromeEvidenceCommit (native ledger adapter)', () => {
  const producer = Object.freeze({
    pid: 4242,
    creationTimeUtc: '2026-07-30T12:34:56.789Z',
    creationTimeHash: '1'.repeat(64),
    executableHash: '2'.repeat(64),
    commandHash: '3'.repeat(64),
  });
  const request: MonochromeEvidenceCommitRequest = Object.freeze({
    nativeHandshake: {
      profile: MONOCHROME_VISUAL_TEST,
      ...visualTestExpectation,
    },
    frontendHandshake: {
      profile: MONOCHROME_VISUAL_TEST,
      ...visualTestExpectation,
    },
    readiness: {
      status: 'PASS' as const,
      application: 'READY' as const,
      fixtureSmoke: 'PASS' as const,
      surface: 'route:chat' as const,
      theme: 'monochrome' as const,
      font: 'READY' as const,
      fallback: 'NOT_USED' as const,
    },
    errors: { page: [] as const, native: [] as const },
  });

  it('sends the exact four direct Tauri arguments without renderer denied effects', async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer,
    }));
    const commit = createTauriMonochromeEvidenceCommit(invoke);
    await expect(commit(request)).resolves.toMatchObject({ status: 'COMMITTED' });
    expect(invoke).toHaveBeenCalledWith(MONOCHROME_EVIDENCE_COMMIT_COMMAND, request);
    const sentArguments = invoke.mock.calls[0]?.[1];
    expect(Object.keys(sentArguments!).sort()).toEqual(
      ['errors', 'frontendHandshake', 'nativeHandshake', 'readiness'].sort(),
    );
    expect(JSON.stringify(sentArguments)).not.toMatch(/token|ledgerPath|outputPath/i);
  });

  it('strips a renderer-injected deniedEffects field at the adapter boundary', async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer,
    }));
    const commit = createTauriMonochromeEvidenceCommit(invoke);
    await commit({ ...request, deniedEffects } as unknown as MonochromeEvidenceCommitRequest);
    expect(invoke.mock.calls[0]?.[1]).toEqual(request);
  });

  it.each([
    {},
    {
      status: 'PASS',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer,
    },
    {
      status: 'COMMITTED',
      schemaVersion: 'wrong',
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer,
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: 'b'.repeat(64),
      producer,
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: 'native-ledger',
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer,
      extra: true,
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: { ...producer, pid: 0 },
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: { ...producer, creationTimeUtc: 'not-utc' },
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: { ...producer, executableHash: 'A'.repeat(64) },
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: { ...producer, extra: true },
    },
    {
      status: 'COMMITTED',
      schemaVersion: MONOCHROME_EVIDENCE_SCHEMA_VERSION,
      sessionNonceHash: visualTestExpectation.sessionNonceHash,
      producer: Object.fromEntries(
        Object.entries(producer).filter(([key]) => key !== 'commandHash'),
      ),
    },
  ])('rejects non-exact native result %#', async (result) => {
    const commit = createTauriMonochromeEvidenceCommit(vi.fn(async () => result));
    await expect(commit(request)).rejects.toThrow(/native result invalid/i);
  });
});
