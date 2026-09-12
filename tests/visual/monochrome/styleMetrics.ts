import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { MONOCHROME_FIXTURE_MANIFEST } from './fixture-manifest.ts';

export const MONOCHROME_FIXED_CLOCK = '2026-07-16T12:00:00.000Z';
export const MONOCHROME_RANDOM_SEED = 42;
export const MONOCHROME_RUNTIME_PROFILE = 'monochrome-visual-test';

export type MonochromeTheme = 'monochrome' | 'default' | 'vibespace' | 'jarvis' | 'origami';
export type DocumentMonochromeTheme = 'monochrome' | 'dark' | 'vibespace' | 'jarvis';
export type MonochromeFixtureId = 'chat' | 'settings-appearance' | 'terminal-workbench';

export function documentThemeForRequest(theme: MonochromeTheme): DocumentMonochromeTheme {
  if (theme === 'origami') return 'vibespace';
  if (theme === 'default') return 'dark';
  return theme;
}

export interface BrowserCoverageCase {
  readonly fixtureHash: string;
  readonly fixtureId: MonochromeFixtureId;
  readonly id: string;
  readonly kind: string;
  readonly routeId: string | null;
}

const BROWSER_PROJECTION_FIELDS = Object.freeze([
  'fixtureHash',
  'fixtureId',
  'id',
  'kind',
  'routeId',
] as const);

export function validateBrowserProjection(
  projected: readonly BrowserCoverageCase[],
  authority: readonly BrowserCoverageCase[],
): void {
  if (projected.length !== authority.length) {
    throw new Error(
      `browser projection length drift: projected=${projected.length}, authority=${authority.length}`,
    );
  }
  for (let index = 0; index < authority.length; index += 1) {
    const projectedCase = projected[index];
    const authorityCase = authority[index];
    const keys = Object.keys(projectedCase).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...BROWSER_PROJECTION_FIELDS].sort())) {
      throw new Error(`browser projection object shape drift at row ${index}`);
    }
    for (const field of BROWSER_PROJECTION_FIELDS) {
      if (projectedCase[field] !== authorityCase[field]) {
        throw new Error(`browser projection ${field} drift at row ${index}`);
      }
    }
  }
}

const BROWSER_CASE_IDS = Object.freeze([
  'access:app-host',
  'access:banner',
  'access:locked',
  'detached:dictation',
  'detached:pet-mini-panel',
  'detached:pet-overlay',
  'detached:workbench-main',
  'development:monochrome-workbench',
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

function fixtureForCaseId(id: string): MonochromeFixtureId {
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

export const BROWSER_CASES = Object.freeze(
  BROWSER_CASE_IDS.map((id) => {
    const fixtureId = fixtureForCaseId(id);
    const [kind, suffix] = id.split(':', 2);
    return Object.freeze({
      fixtureHash: MONOCHROME_FIXTURE_MANIFEST.fixtureHashes[fixtureId],
      fixtureId,
      id,
      kind,
      routeId: kind === 'route' ? suffix : null,
    });
  }) as readonly BrowserCoverageCase[],
);
export const NATIVE_CASE_IDS = Object.freeze([
  'native:dictation',
  'native:main',
  'native:pet-mini-panel',
  'native:pet-overlay',
  'native:preview-surface',
  'native:workbench-main',
]);
export const UNAVAILABLE_CASE_ID = 'future:messaging-channels';

if (
  BROWSER_CASES.length !== 79 ||
  NATIVE_CASE_IDS.length !== 6 ||
  UNAVAILABLE_CASE_ID !== 'future:messaging-channels'
) {
  throw new Error(
    'MonoChrome coverage authority drifted from 86=79 browser+6 native+1 unavailable',
  );
}

export const STYLE_METRIC_ORACLE = Object.freeze({
  blurCount: 0,
  gradientCount: 0,
  minimumNormalTextContrast: 4.5,
  shadowCount: 0,
  blockedPendingMc8b: Object.freeze([
    'accentPixelRatio',
    'borderWidths',
    'densityIndicator',
    'labelCasing',
    'labelFontFamily',
    'palette',
    'radiusDistribution',
    'sidebarWidthPx',
  ]),
});

export interface StyleMetrics {
  readonly route: string;
  readonly theme: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly fontReady: boolean;
  readonly fontCount: number;
  readonly colors: Readonly<{
    bodyBackground: string;
    panelBackground: string;
    borderColor: string;
    textColor: string;
    accentColor: string;
  }>;
  readonly borderWidths: readonly number[];
  readonly borderRadiusDistribution: Readonly<Record<string, number>>;
  readonly shadowCount: number;
  readonly gradientCount: number;
  readonly blurCount: number;
  readonly sidebarWidthPx: number | null;
  readonly labelFontFamily: string;
  readonly labelCasing: string;
  readonly accentPixelRatio: number;
  readonly textContrastRatio: number | null;
  readonly densityIndicator: number;
  readonly selectorScopeLeaks: readonly string[];
}

export interface DeterministicStateOptions {
  readonly fixtureId: MonochromeFixtureId;
  readonly origamiGate?: boolean;
  readonly surfaceId: string;
  readonly theme: MonochromeTheme;
}

export interface BrowserScaleRow {
  readonly factor: number;
  readonly label: string;
}

export interface BrowserScaleObservation {
  /** Browser-owned tab zoom returned by chrome.tabs.getZoom. */
  readonly browserZoomFactor: number;
  /** Real tab zoom changes the CSS-pixel ratio even though context deviceScaleFactor stays 1. */
  readonly devicePixelRatio: number;
  /** Pinch/page-scale emulation changes this value; real desktop tab zoom must leave it at 1. */
  readonly visualViewportScale: number | null;
}

export interface BrowserScaleDriver {
  readonly setBrowserZoom: (factor: number) => Promise<void>;
  readonly resetBrowserZoom: () => Promise<void>;
  readonly observeBrowserScale: () => Promise<BrowserScaleObservation>;
  readonly detach: () => Promise<void>;
}

export interface FocusStyleSnapshot {
  readonly backgroundColor: string;
  readonly borderTopColor: string;
  readonly borderTopStyle: string;
  readonly borderTopWidth: string;
  readonly boxShadow: string;
  readonly outlineColor: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
}

export interface FocusIndicatorEvidence {
  readonly before: FocusStyleSnapshot;
  readonly beforeFocusedContrast: number | null;
  readonly focused: FocusStyleSnapshot;
  readonly indicator: 'background' | 'border' | 'boxShadow' | 'outline' | null;
  readonly renderedChangedPixelCount: number;
  readonly renderedContrastPixelCount: number;
}

const MIN_RENDERED_FOCUS_PIXELS = 4;

function renderedPixelLuminance(red: number, green: number, blue: number): number {
  return [red, green, blue]
    .map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function opaqueRenderedPixel(data: Uint8Array, offset: number): readonly [number, number, number] {
  const alpha = data[offset + 3] / 255;
  return [
    data[offset] * alpha + 255 * (1 - alpha),
    data[offset + 1] * alpha + 255 * (1 - alpha),
    data[offset + 2] * alpha + 255 * (1 - alpha),
  ];
}

export function assessRenderedFocusPixels(
  beforePng: Uint8Array,
  focusedPng: Uint8Array,
): {
  readonly changedPixelCount: number;
  readonly contrastPixelCount: number;
  readonly hasRenderedDelta: boolean;
  readonly maxContrast: number | null;
  readonly passesContrast: boolean;
} {
  const before = PNG.sync.read(Buffer.from(beforePng));
  const focused = PNG.sync.read(Buffer.from(focusedPng));
  if (before.width !== focused.width || before.height !== focused.height) {
    throw new Error('rendered focus captures must have identical dimensions');
  }

  let changedPixelCount = 0;
  let contrastPixelCount = 0;
  let maxContrast: number | null = null;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    const beforePixel = opaqueRenderedPixel(before.data, offset);
    const focusedPixel = opaqueRenderedPixel(focused.data, offset);
    if (beforePixel.every((channel, index) => channel === focusedPixel[index])) continue;

    changedPixelCount += 1;
    const beforeLuminance = renderedPixelLuminance(...beforePixel);
    const focusedLuminance = renderedPixelLuminance(...focusedPixel);
    const contrast =
      (Math.max(beforeLuminance, focusedLuminance) + 0.05) /
      (Math.min(beforeLuminance, focusedLuminance) + 0.05);
    maxContrast = Math.max(maxContrast ?? 0, contrast);
    if (contrast >= 3) contrastPixelCount += 1;
  }

  const hasRenderedDelta = changedPixelCount >= MIN_RENDERED_FOCUS_PIXELS;
  return {
    changedPixelCount,
    contrastPixelCount,
    hasRenderedDelta,
    maxContrast,
    passesContrast:
      hasRenderedDelta &&
      contrastPixelCount >= MIN_RENDERED_FOCUS_PIXELS &&
      maxContrast !== null &&
      maxContrast >= 3,
  };
}

export function assessFocusIndicatorEvidence(evidence: FocusIndicatorEvidence): {
  readonly hasVisibleDelta: boolean;
  readonly passesContrast: boolean;
} {
  const { before, focused, indicator } = evidence;
  const hasVisibleDelta =
    indicator === 'outline'
      ? (before.outlineColor !== focused.outlineColor ||
          before.outlineStyle !== focused.outlineStyle ||
          before.outlineWidth !== focused.outlineWidth) &&
        focused.outlineStyle !== 'none' &&
        Number.parseFloat(focused.outlineWidth) > 0
      : indicator === 'boxShadow'
        ? before.boxShadow !== focused.boxShadow && focused.boxShadow !== 'none'
        : indicator === 'border'
          ? (before.borderTopColor !== focused.borderTopColor ||
              before.borderTopStyle !== focused.borderTopStyle ||
              before.borderTopWidth !== focused.borderTopWidth) &&
            focused.borderTopStyle !== 'none' &&
            Number.parseFloat(focused.borderTopWidth) > 0
          : indicator === 'background'
            ? before.backgroundColor !== focused.backgroundColor
            : false;
  const hasRenderedDelta =
    evidence.renderedChangedPixelCount >= MIN_RENDERED_FOCUS_PIXELS &&
    evidence.renderedContrastPixelCount >= MIN_RENDERED_FOCUS_PIXELS;
  return {
    hasVisibleDelta: hasVisibleDelta && hasRenderedDelta,
    passesContrast:
      hasVisibleDelta &&
      hasRenderedDelta &&
      evidence.beforeFocusedContrast !== null &&
      Number.isFinite(evidence.beforeFocusedContrast) &&
      evidence.beforeFocusedContrast >= 3,
  };
}

const guardedContexts = new WeakSet<BrowserContext>();
const deterministicClockPages = new WeakSet<Page>();
const normalizedTimelinePages = new WeakSet<Page>();
const pausedTimelinePages = new WeakSet<Page>();
const deterministicPages = new WeakSet<Page>();
const externalAttempts = new WeakMap<BrowserContext, string[]>();
const DETERMINISTIC_CLOCK_BOOTSTRAP_MS = 1_024;
const DETERMINISTIC_FRAME_MS = 16;
const REQUIRED_STABLE_FRAME_TRANSITIONS = 3;
const DEFAULT_MAXIMUM_DETERMINISTIC_FRAMES = 240;

function isLoopbackUrl(raw: string): boolean {
  const url = new URL(raw);
  return (
    ['about:', 'blob:', 'data:'].includes(url.protocol) ||
    (['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost'].includes(url.hostname))
  );
}

export async function installLoopbackNetworkGuard(page: Page): Promise<void> {
  const context = page.context();
  externalAttempts.set(context, []);
  if (guardedContexts.has(context)) return;
  guardedContexts.add(context);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isLoopbackUrl(url)) {
      await route.continue();
      return;
    }
    externalAttempts.get(context)?.push(url);
    await route.abort('blockedbyclient');
  });
}

export function assertNoExternalRequests(page: Page): void {
  expect(externalAttempts.get(page.context()) ?? [], 'loopback-only network contract').toEqual([]);
}

export function createDeterministicCryptoProxy<
  T extends object,
  O extends Readonly<Record<'getRandomValues' | 'randomUUID', unknown>>,
>(nativeCrypto: T, overrides: O): T & O {
  return new Proxy(nativeCrypto, {
    get(target, property) {
      if (property === 'getRandomValues') return overrides.getRandomValues;
      if (property === 'randomUUID') return overrides.randomUUID;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & O;
}

function installDeterministicBrowserPrimitives(
  { seed }: { readonly seed: number },
  createCryptoProxy: typeof createDeterministicCryptoProxy,
): void {
  let mathState = seed;
  const nextMath = () => {
    mathState = (mathState * 16807) % 2147483647;
    return (mathState - 1) / 2147483646;
  };
  Object.defineProperty(Math, 'random', {
    configurable: false,
    value: nextMath,
    writable: false,
  });

  const nativeCrypto = globalThis.crypto;
  let cryptoState = seed ^ 0x9e3779b9;
  const nextByte = () => {
    cryptoState ^= cryptoState << 13;
    cryptoState ^= cryptoState >>> 17;
    cryptoState ^= cryptoState << 5;
    return cryptoState & 0xff;
  };
  const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    if (array.byteLength > 65_536) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = nextByte();
    return array;
  };
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  };
  const deterministicCrypto = createCryptoProxy(nativeCrypto, {
    getRandomValues,
    randomUUID,
  });
  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: false,
      value: deterministicCrypto,
      writable: false,
    });
  } catch {
    throw new Error('deterministic Web Crypto installation failed');
  }

  const firstMath = Math.random();
  mathState = seed;
  if (Math.random() !== firstMath) throw new Error('Math.random determinism proof failed');
  mathState = seed;
  const firstCrypto = [...crypto.getRandomValues(new Uint8Array(8))];
  cryptoState = seed ^ 0x9e3779b9;
  const secondCrypto = [...crypto.getRandomValues(new Uint8Array(8))];
  if (firstCrypto.join(',') !== secondCrypto.join(',')) {
    throw new Error('Web Crypto determinism proof failed');
  }
  cryptoState = seed ^ 0x9e3779b9;
}

function normalizeDeterministicBrowserTimeline({
  frameDuration,
  performanceBase,
}: {
  readonly frameDuration: number;
  readonly performanceBase: number;
}): void {
  const clockPerformanceNow = performance.now.bind(performance);
  const clockPerformanceOrigin = clockPerformanceNow();
  const deterministicPerformanceNow = () =>
    performanceBase + clockPerformanceNow() - clockPerformanceOrigin;
  Object.defineProperty(performance, 'now', {
    configurable: false,
    value: deterministicPerformanceNow,
    writable: false,
  });

  const clockSetTimeout = setTimeout.bind(globalThis);
  const clockClearTimeout = clearTimeout.bind(globalThis);
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: false,
    value: (callback: FrameRequestCallback) => {
      const now = deterministicPerformanceNow();
      const delay = frameDuration - ((now - performanceBase) % frameDuration);
      return clockSetTimeout(() => callback(deterministicPerformanceNow()), delay);
    },
    writable: false,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: false,
    value: (handle: number) => clockClearTimeout(handle),
    writable: false,
  });
}

/**
 * Installs Playwright Clock before navigation. The clock must keep flowing
 * during application bootstrap; pausing before navigation can deadlock pages
 * whose startup uses timers.
 */
export async function installDeterministicTimeline(
  page: Page,
  clock = MONOCHROME_FIXED_CLOCK,
): Promise<void> {
  if (deterministicClockPages.has(page)) return;
  const fixedEpoch = Date.parse(clock);
  if (!Number.isFinite(fixedEpoch)) throw new Error(`invalid deterministic clock: ${clock}`);
  await page.clock.install({ time: fixedEpoch });
  deterministicClockPages.add(page);
}

async function pauseDeterministicTimeline(page: Page): Promise<void> {
  if (!deterministicClockPages.has(page) || pausedTimelinePages.has(page)) return;
  const currentClockTime = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(currentClockTime + DETERMINISTIC_CLOCK_BOOTSTRAP_MS);
  await page.clock.setSystemTime(Date.parse(MONOCHROME_FIXED_CLOCK));
  if (!normalizedTimelinePages.has(page)) {
    await page.evaluate(normalizeDeterministicBrowserTimeline, {
      frameDuration: DETERMINISTIC_FRAME_MS,
      performanceBase: DETERMINISTIC_CLOCK_BOOTSTRAP_MS,
    });
    normalizedTimelinePages.add(page);
  }
  pausedTimelinePages.add(page);
}

async function resumeDeterministicTimeline(page: Page, nextDocument = false): Promise<void> {
  if (pausedTimelinePages.has(page)) {
    await page.clock.resume();
    pausedTimelinePages.delete(page);
  }
  if (nextDocument) normalizedTimelinePages.delete(page);
}

export async function withDeterministicTimelineRunning<T>(
  page: Page,
  operation: () => Promise<T>,
): Promise<T> {
  await resumeDeterministicTimeline(page);
  try {
    return await operation();
  } finally {
    await pauseDeterministicTimeline(page);
  }
}

/**
 * Freezes platform primitives only. Product fixture/profile/theme/readiness
 * evidence must come from application-owned DOM, never from this init script.
 */
export async function installDeterministicPrimitives(page: Page): Promise<void> {
  if ((page as Partial<Page>).clock !== undefined) {
    await installDeterministicTimeline(page);
  }
  if (deterministicPages.has(page)) return;
  const argumentsJson = JSON.stringify({
    seed: MONOCHROME_RANDOM_SEED,
  });
  await page.addInitScript({
    content: `(${installDeterministicBrowserPrimitives.toString()})(${argumentsJson}, (${createDeterministicCryptoProxy.toString()}));`,
  });
  deterministicPages.add(page);
}

const BROWSER_SCALE_TOLERANCE = 0.001;

function authenticateBrowserScale(
  observation: BrowserScaleObservation,
  expectedFactor: number,
  label: string,
): Readonly<BrowserScaleObservation> {
  if (
    !Number.isFinite(observation.browserZoomFactor) ||
    Math.abs(observation.browserZoomFactor - expectedFactor) > BROWSER_SCALE_TOLERANCE
  ) {
    throw new Error(
      `${label} browser zoom mismatch: expected ${expectedFactor}, observed ${String(
        observation.browserZoomFactor,
      )}`,
    );
  }
  if (
    !Number.isFinite(observation.devicePixelRatio) ||
    Math.abs(observation.devicePixelRatio - expectedFactor) > BROWSER_SCALE_TOLERANCE
  ) {
    throw new Error(
      `${label} devicePixelRatio mismatch: expected ${expectedFactor}, observed ${observation.devicePixelRatio}`,
    );
  }
  if (
    observation.visualViewportScale === null ||
    !Number.isFinite(observation.visualViewportScale) ||
    Math.abs(observation.visualViewportScale - 1) > BROWSER_SCALE_TOLERANCE
  ) {
    throw new Error(
      `${label} visualViewport scale must remain 1 for real tab zoom, observed ${String(
        observation.visualViewportScale,
      )}`,
    );
  }
  return Object.freeze({ ...observation });
}

export async function runAuthenticatedBrowserScale<T>(
  zoom: BrowserScaleRow,
  driver: BrowserScaleDriver,
  operation: (observation: Readonly<BrowserScaleObservation>) => Promise<T>,
): Promise<T> {
  try {
    await driver.setBrowserZoom(zoom.factor);
    const requested = authenticateBrowserScale(
      await driver.observeBrowserScale(),
      zoom.factor,
      `requested browser zoom ${zoom.label}`,
    );
    return await operation(requested);
  } finally {
    try {
      await driver.resetBrowserZoom();
      authenticateBrowserScale(await driver.observeBrowserScale(), 1, 'restored browser zoom');
    } finally {
      await driver.detach();
    }
  }
}

async function createPlaywrightBrowserScaleDriver(page: Page): Promise<BrowserScaleDriver> {
  const context = page.context();
  const workerPromise = (async () => {
    const existing = context
      .serviceWorkers()
      .find((worker) => worker.url().endsWith('/background.js'));
    return (
      existing ??
      (await context.waitForEvent('serviceworker', {
        predicate: (worker) => worker.url().endsWith('/background.js'),
        timeout: 5_000,
      }))
    );
  })();
  const useActiveTab = async (action: 'get' | 'set', factor = 1): Promise<number> => {
    const worker = await workerPromise;
    return worker.evaluate(
      async ({ action: requestedAction, factor: requestedFactor }) => {
        const browser = globalThis as typeof globalThis & {
          chrome: {
            tabs: {
              getZoom: (tabId: number) => Promise<number>;
              query: (queryInfo: {
                active: boolean;
                currentWindow: boolean;
              }) => Promise<Array<{ id?: number }>>;
              setZoom: (tabId: number, factor: number) => Promise<void>;
            };
          };
        };
        const [tab] = await browser.chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) throw new Error('browser zoom extension found no active tab');
        if (requestedAction === 'set') {
          await browser.chrome.tabs.setZoom(tab.id, requestedFactor);
        }
        return browser.chrome.tabs.getZoom(tab.id);
      },
      { action, factor },
    );
  };
  return {
    setBrowserZoom: async (factor) => {
      await useActiveTab('set', factor);
    },
    resetBrowserZoom: async () => {
      await useActiveTab('set', 1);
    },
    observeBrowserScale: async () => {
      const pageObservation = await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        return {
          devicePixelRatio: window.devicePixelRatio,
          visualViewportScale: window.visualViewport?.scale ?? null,
        };
      });
      const browserZoomFactor = await useActiveTab('get');
      return { browserZoomFactor, ...pageObservation };
    },
    detach: async () => {
      await workerPromise;
    },
  };
}

export async function withAuthenticatedBrowserScale<T>(
  page: Page,
  zoom: BrowserScaleRow,
  operation: (observation: Readonly<BrowserScaleObservation>) => Promise<T>,
): Promise<T> {
  const driver = await createPlaywrightBrowserScaleDriver(page);
  return runAuthenticatedBrowserScale(zoom, driver, operation);
}

function requestedPath(pathname: string, options: DeterministicStateOptions): string {
  const request = new URL(pathname, 'http://127.0.0.1');
  request.searchParams.set('monochrome-fixture', options.fixtureId);
  request.searchParams.set(
    'monochrome-fixture-hash',
    MONOCHROME_FIXTURE_MANIFEST.fixtureHashes[options.fixtureId],
  );
  request.searchParams.set('monochrome-surface', options.surfaceId);
  request.searchParams.set('monochrome-theme', options.theme);
  request.searchParams.set('monochrome-origami-gate', String(options.origamiGate ?? false));
  return `${request.pathname}${request.search}`;
}

interface DeterministicCaptureOptions {
  readonly maximumFrames?: number;
}

interface DeterministicReadinessObservation {
  readonly asyncRendererReady: boolean;
  readonly fontsReady: boolean;
  readonly imagesReady: boolean;
  readonly signature: string;
}

export async function resetDeterministicScrollPositions(page: Page): Promise<void> {
  const remaining = await page.evaluate(() => {
    scrollTo(0, 0);
    const candidates = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll<HTMLElement>('*'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    for (const element of candidates) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    }
    return candidates.filter((element) => element.scrollLeft !== 0 || element.scrollTop !== 0)
      .length;
  });
  if (remaining !== 0) {
    throw new Error(`deterministic scroll reset left ${remaining} scrolled elements`);
  }
}

export async function stabilizeDeterministicCapture(
  page: Page,
  surfaceId: string,
  options: DeterministicCaptureOptions = {},
): Promise<void> {
  const maximumFrames = options.maximumFrames ?? DEFAULT_MAXIMUM_DETERMINISTIC_FRAMES;
  if (!Number.isInteger(maximumFrames) || maximumFrames < REQUIRED_STABLE_FRAME_TRANSITIONS + 1) {
    throw new Error('maximum deterministic frames cannot prove three stable transitions');
  }

  await pauseDeterministicTimeline(page);
  let previousSignature = '';
  let stableTransitions = 0;
  let lastObservation: DeterministicReadinessObservation | null = null;
  for (let frame = 1; frame <= maximumFrames; frame += 1) {
    await page.clock.runFor(DETERMINISTIC_FRAME_MS);
    const observation = await page.evaluate(
      (requestedSurfaceId): DeterministicReadinessObservation => {
        const root = [
          ...document.querySelectorAll<HTMLElement>('[data-monochrome-surface-id]'),
        ].find((element) => element.dataset.monochromeSurfaceId === requestedSurfaceId);
        const bounds = root?.getBoundingClientRect();
        const asynchronousRenderer = root?.querySelector<HTMLElement>('[data-pet-render-ready]');
        return {
          asyncRendererReady:
            (requestedSurfaceId !== 'overlay:pet-host' && asynchronousRenderer === null) ||
            asynchronousRenderer?.dataset.petRenderReady === 'true',
          fontsReady: document.fonts.status === 'loaded',
          imagesReady: [...document.images].every((image) => image.complete),
          signature: [
            bounds?.x,
            bounds?.y,
            bounds?.width,
            bounds?.height,
            document.documentElement.scrollWidth,
            document.documentElement.scrollHeight,
          ].join(':'),
        };
      },
      surfaceId,
    );
    const productReady =
      observation.asyncRendererReady && observation.fontsReady && observation.imagesReady;
    stableTransitions =
      productReady && observation.signature === previousSignature ? stableTransitions + 1 : 0;
    previousSignature = observation.signature;
    lastObservation = observation;
    if (stableTransitions >= REQUIRED_STABLE_FRAME_TRANSITIONS) {
      await page.clock.setSystemTime(Date.parse(MONOCHROME_FIXED_CLOCK));
      await resetDeterministicScrollPositions(page);
      return;
    }
  }

  throw new Error(
    `deterministic capture did not reach three product-ready stable frames in ${maximumFrames} frames: ${JSON.stringify(
      lastObservation,
    )}`,
  );
}

export async function waitForDeterministicReadiness(
  page: Page,
  options: DeterministicStateOptions,
): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-runtime-profile-handshake="ready"]').waitFor({ state: 'attached' });
  const evidence = page.locator('[data-monochrome-fixture-ready="true"]').first();
  await evidence.waitFor({ state: 'attached' });
  await expect(evidence).toHaveAttribute('data-runtime-profile', MONOCHROME_RUNTIME_PROFILE);
  await expect(evidence).toHaveAttribute(
    'data-fixture-hash',
    MONOCHROME_FIXTURE_MANIFEST.fixtureHashes[options.fixtureId],
  );
  const productSurface = page.locator(`[data-monochrome-surface-id="${options.surfaceId}"]`);
  await expect(productSurface).toHaveCount(1);
  await expect(productSurface).toBeVisible();
  await expect(evidence).toHaveAttribute('data-resolved-theme', options.theme);
  await expect(evidence).toHaveAttribute(
    'data-document-theme',
    documentThemeForRequest(options.theme),
  );
  await expect(evidence).toHaveAttribute('data-font-ready', 'true');
  await expect(evidence).toHaveAttribute('data-fallback', 'false');
  await expect(evidence).toHaveAttribute('data-origami-gate', String(options.origamiGate ?? false));

  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map((image) => image.decode().catch(() => undefined)),
    );
  });
  await stabilizeDeterministicCapture(page, options.surfaceId);
  const asynchronousPetRenderer = productSurface.locator('[data-pet-render-ready]').first();
  if ((await asynchronousPetRenderer.count()) === 1) {
    await expect(asynchronousPetRenderer).toHaveAttribute('data-pet-render-ready', 'true');
  }
  assertNoExternalRequests(page);
}

export async function prepareDeterministicPage(
  page: Page,
  path: string,
  options: DeterministicStateOptions,
): Promise<void> {
  await installLoopbackNetworkGuard(page);
  await installDeterministicPrimitives(page);
  await resumeDeterministicTimeline(page, true);
  await page.goto(requestedPath(path, options), { waitUntil: 'domcontentloaded' });
  await waitForDeterministicReadiness(page, options);
}

export async function assertMeaningfulSurface(page: Page, surfaceId: string): Promise<Locator> {
  const surface = page.locator(`[data-monochrome-surface-id="${surfaceId}"]`).first();
  await expect(surface).toBeVisible();
  const summary = await surface.evaluate((element) => {
    const evidenceRoot = element as HTMLElement;
    const descendants = Array.from(evidenceRoot.querySelectorAll<HTMLElement>('*'));
    const candidates = [evidenceRoot, ...descendants];
    type Bounds = { bottom: number; left: number; right: number; top: number };
    const boundsForRect = (rect: DOMRect): Bounds => ({
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
    });
    const intersectBounds = (first: Bounds, second: Bounds): Bounds | null => {
      const intersection = {
        bottom: Math.min(first.bottom, second.bottom),
        left: Math.max(first.left, second.left),
        right: Math.min(first.right, second.right),
        top: Math.max(first.top, second.top),
      };
      return intersection.right > intersection.left && intersection.bottom > intersection.top
        ? intersection
        : null;
    };
    const viewportBounds: Bounds = {
      bottom: innerHeight,
      left: 0,
      right: innerWidth,
      top: 0,
    };
    const parseOffset = (token: string, size: number): number | null => {
      const match = token.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)?$/u);
      if (!match) return null;
      const value = Number(match[1]);
      if (!Number.isFinite(value)) return null;
      if (match[2] === '%') return (value / 100) * size;
      if (match[2] === undefined && value !== 0) return null;
      return value;
    };
    const expandBoxOffsets = (tokens: readonly string[]): readonly string[] | null => {
      if (tokens.length < 1 || tokens.length > 4) return null;
      if (tokens.length === 1) return [tokens[0]!, tokens[0]!, tokens[0]!, tokens[0]!];
      if (tokens.length === 2) return [tokens[0]!, tokens[1]!, tokens[0]!, tokens[1]!];
      if (tokens.length === 3) return [tokens[0]!, tokens[1]!, tokens[2]!, tokens[1]!];
      return tokens;
    };
    const insetBounds = (rect: Bounds, tokens: readonly string[]): Bounds | null | undefined => {
      const expanded = expandBoxOffsets(tokens);
      if (!expanded) return undefined;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      const parsed = expanded.map((token, index) =>
        parseOffset(token, index % 2 === 0 ? height : width),
      );
      if (parsed.some((value) => value === null)) return undefined;
      const [top, right, bottom, left] = parsed as [number, number, number, number];
      const clipped = {
        bottom: rect.bottom - bottom,
        left: rect.left + left,
        right: rect.right - right,
        top: rect.top + top,
      };
      return clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
    };
    const cssClipBounds = (
      candidate: HTMLElement,
      style: CSSStyleDeclaration,
    ): Bounds | null | undefined => {
      const rect = boundsForRect(candidate.getBoundingClientRect());
      let clipped: Bounds | null | undefined;
      if (style.clip !== 'auto' && (style.position === 'absolute' || style.position === 'fixed')) {
        const legacy = style.clip.match(/^rect\((.*)\)$/u);
        if (legacy) {
          const tokens = legacy[1]!.split(/[\s,]+/u).filter(Boolean);
          if (tokens.length === 4) {
            const width = rect.right - rect.left;
            const height = rect.bottom - rect.top;
            const values = tokens.map((token, index) => {
              if (token === 'auto') return [0, width, height, 0][index]!;
              return parseOffset(token, index % 2 === 0 ? height : width);
            });
            if (!values.some((value) => value === null)) {
              const [top, right, bottom, left] = values as [number, number, number, number];
              const legacyBounds = {
                bottom: rect.top + bottom,
                left: rect.left + left,
                right: rect.left + right,
                top: rect.top + top,
              };
              clipped =
                legacyBounds.right > legacyBounds.left && legacyBounds.bottom > legacyBounds.top
                  ? legacyBounds
                  : null;
            }
          }
        }
      }
      if (clipped === null) return null;
      if (style.clipPath !== 'none') {
        const inset = style.clipPath.match(/^inset\((.*)\)$/u);
        if (inset) {
          const beforeRound = inset[1]!.split(/\s+round\s+/u, 1)[0]!;
          const clipPathBounds = insetBounds(rect, beforeRound.split(/\s+/u).filter(Boolean));
          if (clipPathBounds === null) return null;
          if (clipPathBounds !== undefined) {
            clipped =
              clipped === undefined ? clipPathBounds : intersectBounds(clipped, clipPathBounds);
          }
        }
      }
      return clipped;
    };
    const paintedBounds = (candidate: HTMLElement): Bounds | null => {
      let bounds = intersectBounds(
        boundsForRect(candidate.getBoundingClientRect()),
        viewportBounds,
      );
      bounds = bounds
        ? intersectBounds(bounds, boundsForRect(evidenceRoot.getBoundingClientRect()))
        : null;
      if (!bounds) return null;

      let cursor: HTMLElement | null = candidate;
      let reachedEvidenceRoot = false;
      while (cursor) {
        const style = getComputedStyle(cursor);
        if (
          style.display === 'none' ||
          style.contentVisibility === 'hidden' ||
          Number(style.opacity) <= 0
        ) {
          return null;
        }
        if (
          cursor === candidate &&
          (style.visibility === 'hidden' || style.visibility === 'collapse')
        ) {
          return null;
        }
        const clipped = cssClipBounds(cursor, style);
        if (clipped === null) return null;
        if (clipped !== undefined) {
          bounds = intersectBounds(bounds, clipped);
          if (!bounds) return null;
        }
        if (cursor !== candidate) {
          const cursorBounds = boundsForRect(cursor.getBoundingClientRect());
          if (style.overflowX !== 'visible') {
            bounds = intersectBounds(bounds, {
              ...bounds,
              left: cursorBounds.left,
              right: cursorBounds.right,
            });
            if (!bounds) return null;
          }
          if (style.overflowY !== 'visible') {
            bounds = intersectBounds(bounds, {
              ...bounds,
              bottom: cursorBounds.bottom,
              top: cursorBounds.top,
            });
            if (!bounds) return null;
          }
        }
        if (cursor === evidenceRoot) reachedEvidenceRoot = true;
        cursor = cursor.parentElement;
      }
      return reachedEvidenceRoot ? bounds : null;
    };
    const visibleCandidates = candidates.filter((candidate) => paintedBounds(candidate) !== null);
    const visibleDescendants = visibleCandidates.filter((candidate) => candidate !== evidenceRoot);
    const colorHasPaint = (color: string): boolean => {
      const normalized = color.trim().toLowerCase();
      if (normalized === '' || normalized === 'transparent') return false;
      const alpha = normalized.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)$/u);
      return alpha === null || Number(alpha[1]) > 0;
    };
    const solidPaintCount = visibleDescendants.filter((candidate) => {
      const style = getComputedStyle(candidate);
      if (colorHasPaint(style.backgroundColor)) return true;
      return ['top', 'right', 'bottom', 'left'].some((side) => {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
        const borderStyle = style.getPropertyValue(`border-${side}-style`);
        const color = style.getPropertyValue(`border-${side}-color`);
        return (
          Number.isFinite(width) && width > 0 && borderStyle !== 'none' && colorHasPaint(color)
        );
      });
    }).length;
    return {
      graphicCount: visibleCandidates.filter((candidate) =>
        candidate.matches('canvas, img, svg, video'),
      ).length,
      interactiveCount: visibleCandidates.filter((candidate) =>
        candidate.matches(
          'a[href], button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
        ),
      ).length,
      solidPaintCount,
      textLength: visibleCandidates.reduce(
        (length, candidate) =>
          length +
          [...candidate.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .reduce((sum, node) => sum + (node.textContent?.trim().length ?? 0), 0),
        0,
      ),
      visible: paintedBounds(evidenceRoot) !== null,
    };
  });
  expect(summary.visible, `${surfaceId} surface visibility`).toBe(true);
  expect(
    summary.interactiveCount > 0 ||
      summary.textLength > 0 ||
      summary.graphicCount > 0 ||
      summary.solidPaintCount > 0,
    `${surfaceId} meaningful rendered behavior`,
  ).toBe(true);
  return surface;
}

export interface ReducedMotionAnimationObservation {
  readonly durationMs: number | null;
  readonly iterations: number | null;
  readonly properties: readonly string[];
  readonly target: string;
}

export function boxShadowHasVisiblePaint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return false;

  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) return true;
    if (character === ',' && depth === 0) {
      layers.push(normalized.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) return true;
  layers.push(normalized.slice(start).trim());
  if (layers.some((layer) => layer.length === 0)) return true;

  const numericComponent = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/u;
  const parseChannel = (text: string): number | null => {
    if (!numericComponent.test(text)) return null;
    const value = Number.parseFloat(text);
    const maximum = text.endsWith('%') ? 100 : 255;
    return Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
  };
  const parseAlpha = (text: string): number | null => {
    if (!numericComponent.test(text)) return null;
    const value = Number.parseFloat(text);
    const alpha = text.endsWith('%') ? value / 100 : value;
    return Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? alpha : null;
  };

  return layers.some((layer) => {
    const colorPattern = /\b(?:rgb|rgba)\(([^()]*)\)/gu;
    const colors = [...layer.matchAll(colorPattern)];
    if (colors.length !== 1) return true;

    const geometryTokens = layer.replace(colorPattern, '').trim().split(/\s+/u).filter(Boolean);
    const insetCount = geometryTokens.filter((token) => token === 'inset').length;
    if (insetCount > 1) return true;
    const lengths = geometryTokens.filter((token) => token !== 'inset');
    if (lengths.length < 2 || lengths.length > 4) return true;
    const lengthPattern =
      /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|rem|em|ex|ch|vh|vw|vmin|vmax|cm|mm|in|pt|pc|q)?$/u;
    const parsedLengths: number[] = [];
    for (const token of lengths) {
      const match = token.match(lengthPattern);
      if (!match || (match[2] === undefined && Number(match[1]) !== 0)) return true;
      parsedLengths.push(Number(match[1]));
    }
    if (parsedLengths.length >= 3 && parsedLengths[2]! < 0) return true;

    const body = colors[0]![1]!.trim();
    let channels: string[];
    let alphaText: string | null = null;

    if (body.includes(',')) {
      if (body.includes('/')) return true;
      const components = body.split(',').map((component) => component.trim());
      if (
        (components.length !== 3 && components.length !== 4) ||
        components.some((component) => !component)
      ) {
        return true;
      }
      channels = components.slice(0, 3);
      alphaText = components[3] ?? null;
    } else {
      const slashParts = body.split('/');
      if (slashParts.length > 2) return true;
      channels = slashParts[0]!.trim().split(/\s+/u).filter(Boolean);
      if (channels.length !== 3) return true;
      if (slashParts.length === 2) {
        const alphaParts = slashParts[1]!.trim().split(/\s+/u).filter(Boolean);
        if (alphaParts.length !== 1) return true;
        alphaText = alphaParts[0]!;
      }
    }

    if (channels.length !== 3 || channels.some((channel) => parseChannel(channel) === null)) {
      return true;
    }
    const alpha = alphaText === null ? 1 : parseAlpha(alphaText);
    if (alpha === null) return true;
    return alpha > 0 && parsedLengths.some((length) => length !== 0);
  });
}

export function reducedMotionViolations(
  observations: readonly ReducedMotionAnimationObservation[],
): string[] {
  return observations.map((observation) => {
    const properties = [...new Set(observation.properties)].sort();
    return `${observation.target}: running reduced-motion animation properties ${
      properties.join(',') || 'unknown'
    }, duration ${observation.durationMs}, iterations ${observation.iterations}`;
  });
}

export async function assertProductReducedMotion(page: Page): Promise<void> {
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter(({ playState }) => playState === 'running')
      .map((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) {
          return {
            durationMs: null,
            iterations: null,
            properties: [],
            target: 'unknown',
          };
        }
        const timing = effect.getComputedTiming();
        const metadataKeys = new Set(['composite', 'computedOffset', 'easing', 'offset']);
        return {
          durationMs: typeof timing.duration === 'number' ? timing.duration : null,
          iterations: typeof timing.iterations === 'number' ? timing.iterations : null,
          properties: [
            ...new Set(
              effect
                .getKeyframes()
                .flatMap((frame) => Object.keys(frame))
                .filter((property) => !metadataKeys.has(property)),
            ),
          ].sort(),
          target: effect.target instanceof Element ? effect.target.tagName : 'unknown',
        };
      }),
  );
  expect(
    reducedMotionViolations(running),
    'product reduced-motion behavior before screenshot suppression',
  ).toEqual([]);
}

export async function disableCaptureMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
}

export function browserPathForEntry(entry: BrowserCoverageCase): string {
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

/** Collects metrics; fields without an approved MC8B oracle remain explicitly blocked. */
export async function collectStyleMetrics(
  page: Page,
  route: string,
  theme: string,
): Promise<StyleMetrics> {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const raw = await page.evaluate(
    ({ activeTheme, surfaceId }) => {
      type Rgba = [number, number, number, number];
      const parseColor = (value: string): Rgba | null => {
        const match = value.match(
          /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/u,
        );
        return match
          ? [
              Number(match[1]),
              Number(match[2]),
              Number(match[3]),
              match[4] === undefined ? 1 : Number(match[4]),
            ]
          : null;
      };
      const composite = (foreground: Rgba, background: Rgba): Rgba => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        if (alpha === 0) return [0, 0, 0, 0];
        return [
          (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) /
            alpha,
          (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) /
            alpha,
          (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) /
            alpha,
          alpha,
        ];
      };
      const effectiveBackground = (element: Element | null): Rgba => {
        const layers: Rgba[] = [];
        let cursor = element;
        while (cursor) {
          const parsed = parseColor(getComputedStyle(cursor).backgroundColor);
          if (parsed) layers.push(parsed);
          cursor = cursor.parentElement;
        }
        let result: Rgba = [255, 255, 255, 1];
        for (const layer of layers.reverse()) result = composite(layer, result);
        return result;
      };
      const luminance = ([red, green, blue]: Rgba): number =>
        [red, green, blue]
          .map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = (foreground: string, element: Element): number | null => {
        const parsed = parseColor(foreground);
        if (!parsed) return null;
        const background = effectiveBackground(element);
        const effectiveForeground = composite(parsed, background);
        const first = luminance(effectiveForeground);
        const second = luminance(background);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };

      const evidenceRoot = [
        ...document.querySelectorAll<HTMLElement>('[data-monochrome-surface-id]'),
      ].find((element) => element.dataset.monochromeSurfaceId === surfaceId);
      if (!evidenceRoot) throw new Error(`Authenticated surface ${surfaceId} is unavailable.`);
      const surfaceElements = [evidenceRoot, ...evidenceRoot.querySelectorAll<HTMLElement>('*')];
      type Bounds = { bottom: number; left: number; right: number; top: number };
      const boundsForRect = (rect: DOMRect): Bounds => ({
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      });
      const intersectBounds = (first: Bounds, second: Bounds): Bounds | null => {
        const intersection = {
          bottom: Math.min(first.bottom, second.bottom),
          left: Math.max(first.left, second.left),
          right: Math.min(first.right, second.right),
          top: Math.max(first.top, second.top),
        };
        return intersection.right > intersection.left && intersection.bottom > intersection.top
          ? intersection
          : null;
      };
      const boundsArea = (bounds: Bounds | null): number =>
        bounds ? (bounds.right - bounds.left) * (bounds.bottom - bounds.top) : 0;
      const viewportBounds: Bounds = {
        bottom: innerHeight,
        left: 0,
        right: innerWidth,
        top: 0,
      };
      const parseOffset = (token: string, size: number): number | null => {
        const match = token.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)?$/u);
        if (!match) return null;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return null;
        if (match[2] === '%') return (value / 100) * size;
        if (match[2] === undefined && value !== 0) return null;
        return value;
      };
      const expandBoxOffsets = (tokens: readonly string[]): readonly string[] | null => {
        if (tokens.length < 1 || tokens.length > 4) return null;
        if (tokens.length === 1) return [tokens[0]!, tokens[0]!, tokens[0]!, tokens[0]!];
        if (tokens.length === 2) return [tokens[0]!, tokens[1]!, tokens[0]!, tokens[1]!];
        if (tokens.length === 3) return [tokens[0]!, tokens[1]!, tokens[2]!, tokens[1]!];
        return tokens;
      };
      const insetBounds = (rect: Bounds, tokens: readonly string[]): Bounds | null | undefined => {
        const expanded = expandBoxOffsets(tokens);
        if (!expanded) return undefined;
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        const parsed = expanded.map((token, index) =>
          parseOffset(token, index % 2 === 0 ? height : width),
        );
        if (parsed.some((value) => value === null)) return undefined;
        const [top, right, bottom, left] = parsed as [number, number, number, number];
        const clipped = {
          bottom: rect.bottom - bottom,
          left: rect.left + left,
          right: rect.right - right,
          top: rect.top + top,
        };
        return clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
      };
      const cssClipBounds = (
        element: HTMLElement,
        style: CSSStyleDeclaration,
      ): Bounds | null | undefined => {
        const rect = boundsForRect(element.getBoundingClientRect());
        let clipped: Bounds | null | undefined = rect;
        if (
          style.clip !== 'auto' &&
          (style.position === 'absolute' || style.position === 'fixed')
        ) {
          const legacy = style.clip.match(/^rect\((.*)\)$/u);
          if (legacy) {
            const tokens = legacy[1]!.split(/[\s,]+/u).filter(Boolean);
            if (tokens.length === 4) {
              const width = rect.right - rect.left;
              const height = rect.bottom - rect.top;
              const values = tokens.map((token, index) => {
                if (token === 'auto') return [0, width, height, 0][index]!;
                return parseOffset(token, index % 2 === 0 ? height : width);
              });
              if (!values.some((value) => value === null)) {
                const [top, right, bottom, left] = values as [number, number, number, number];
                const legacyBounds = {
                  bottom: rect.top + bottom,
                  left: rect.left + left,
                  right: rect.left + right,
                  top: rect.top + top,
                };
                clipped =
                  legacyBounds.right > legacyBounds.left && legacyBounds.bottom > legacyBounds.top
                    ? legacyBounds
                    : null;
              }
            }
          }
        }
        if (clipped === null) return null;

        if (style.clipPath !== 'none') {
          const inset = style.clipPath.match(/^inset\((.*)\)$/u);
          if (inset) {
            const beforeRound = inset[1]!.split(/\s+round\s+/u, 1)[0]!;
            const clipPathBounds = insetBounds(rect, beforeRound.split(/\s+/u).filter(Boolean));
            if (clipPathBounds === null) return null;
            if (clipPathBounds !== undefined) {
              clipped =
                clipped === undefined ? clipPathBounds : intersectBounds(clipped, clipPathBounds);
            }
          }
        }
        return clipped;
      };
      const paintedBounds = (element: HTMLElement): Bounds | null => {
        let bounds = intersectBounds(
          boundsForRect(element.getBoundingClientRect()),
          viewportBounds,
        );
        bounds = bounds
          ? intersectBounds(bounds, boundsForRect(evidenceRoot.getBoundingClientRect()))
          : null;
        if (!bounds) return null;

        let cursor: HTMLElement | null = element;
        let reachedEvidenceRoot = false;
        while (cursor) {
          const style = getComputedStyle(cursor);
          if (
            style.display === 'none' ||
            style.contentVisibility === 'hidden' ||
            Number(style.opacity) <= 0
          ) {
            return null;
          }
          if (
            cursor === element &&
            (style.visibility === 'hidden' || style.visibility === 'collapse')
          ) {
            return null;
          }

          const cssBounds = cssClipBounds(cursor, style);
          if (cssBounds === null) return null;
          if (cssBounds !== undefined) {
            bounds = intersectBounds(bounds, cssBounds);
            if (!bounds) return null;
          }

          if (cursor !== element) {
            const cursorBounds = boundsForRect(cursor.getBoundingClientRect());
            if (style.overflowX !== 'visible') {
              bounds = intersectBounds(bounds, {
                ...bounds,
                left: cursorBounds.left,
                right: cursorBounds.right,
              });
              if (!bounds) return null;
            }
            if (style.overflowY !== 'visible') {
              bounds = intersectBounds(bounds, {
                ...bounds,
                bottom: cursorBounds.bottom,
                top: cursorBounds.top,
              });
              if (!bounds) return null;
            }
          }

          if (cursor === evidenceRoot) {
            reachedEvidenceRoot = true;
          }
          cursor = cursor.parentElement;
        }
        return reachedEvidenceRoot ? bounds : null;
      };
      const paintedArea = (element: HTMLElement): number => boundsArea(paintedBounds(element));
      const visibleElements = surfaceElements.filter((element) => paintedArea(element) > 0);
      const withinSurface = <T extends HTMLElement>(selector: string): T | null =>
        (visibleElements.find((element) => element.matches(selector)) as T | undefined) ?? null;
      const bodyStyle = getComputedStyle(document.body);
      const panel =
        withinSurface<HTMLElement>('[data-panel], [role="complementary"], aside, .panel') ??
        evidenceRoot;
      const panelStyle = getComputedStyle(panel);
      const radiusMap: Record<string, number> = {};
      const borderWidths = new Set<number>();
      const boxShadowValues: string[] = [];
      let gradientCount = 0;
      let blurCount = 0;
      let accentArea = 0;
      let visibleArea = 0;

      for (const element of visibleElements) {
        const style = getComputedStyle(element);
        const area = paintedArea(element);
        visibleArea += area;
        const borderWidth = Number.parseFloat(style.borderTopWidth);
        if (borderWidth > 0) borderWidths.add(borderWidth);
        if (style.borderRadius !== '0px') {
          radiusMap[style.borderRadius] = (radiusMap[style.borderRadius] ?? 0) + 1;
        }
        if (style.boxShadow !== 'none') boxShadowValues.push(style.boxShadow);
        if (style.backgroundImage.includes('gradient')) gradientCount += 1;
        if (style.filter.includes('blur') || style.backdropFilter.includes('blur')) blurCount += 1;
        if (
          element.matches(
            '[data-accent], [data-status], [aria-selected="true"], [class*="accent"], [class*="primary"]',
          )
        ) {
          accentArea += area;
        }
      }

      const sidebar = withinSurface<HTMLElement>(
        '[data-sidebar], nav[role="navigation"], aside[class*="sidebar"]',
      );
      const label = withinSurface<HTMLElement>('label, [class*="label"], [data-label]');
      const labelStyle = label ? getComputedStyle(label) : null;
      const accent = withinSurface<HTMLElement>(
        '[data-accent], [data-status], [aria-selected="true"], [class*="accent"], [class*="primary"]',
      );
      const textSample =
        visibleElements.find((element) => {
          return (
            paintedArea(element) > 1 &&
            [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
            )
          );
        }) ?? null;
      const textStyle = textSample ? getComputedStyle(textSample) : null;
      const evidenceRootArea = paintedArea(evidenceRoot);
      const selectors: string[] = [];
      const visitRules = (rules: CSSRuleList) => {
        for (const rule of [...rules]) {
          if (rule instanceof CSSStyleRule) {
            if (
              rule.selectorText.includes('monochrome') &&
              !rule.selectorText.includes('[data-theme="monochrome"]') &&
              !rule.selectorText.includes('[data-monochrome')
            ) {
              selectors.push(rule.selectorText);
            }
          } else if ('cssRules' in rule) {
            visitRules((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      for (const sheet of [...document.styleSheets]) {
        try {
          visitRules(sheet.cssRules);
        } catch {
          // Cross-origin stylesheets are already prohibited by the loopback guard.
        }
      }

      return {
        accentColor: accent ? getComputedStyle(accent).backgroundColor : '',
        accentPixelRatio: visibleArea === 0 ? 0 : accentArea / visibleArea,
        bodyBackground: bodyStyle.backgroundColor,
        borderColor: panelStyle.borderTopColor,
        borderRadiusDistribution: radiusMap,
        borderWidths: [...borderWidths].sort((left, right) => left - right),
        boxShadowValues,
        blurCount,
        densityIndicator: visibleElements.length / Math.max(1, evidenceRootArea),
        fontCount: document.fonts.size,
        fontReady: document.fonts.status === 'loaded',
        gradientCount,
        labelCasing: labelStyle?.textTransform ?? '',
        labelFontFamily: labelStyle?.fontFamily ?? '',
        panelBackground: panelStyle.backgroundColor,
        selectorScopeLeaks: activeTheme === 'monochrome' ? selectors : [],
        sidebarWidthPx: sidebar?.getBoundingClientRect().width ?? null,
        textColor: textStyle?.color ?? '',
        textContrastRatio: textSample && textStyle ? contrast(textStyle.color, textSample) : null,
      };
    },
    { activeTheme: theme, surfaceId: route },
  );

  return {
    route,
    theme,
    viewport,
    fontReady: raw.fontReady,
    fontCount: raw.fontCount,
    colors: {
      bodyBackground: raw.bodyBackground,
      panelBackground: raw.panelBackground,
      borderColor: raw.borderColor,
      textColor: raw.textColor,
      accentColor: raw.accentColor,
    },
    borderWidths: raw.borderWidths,
    borderRadiusDistribution: raw.borderRadiusDistribution,
    shadowCount: raw.boxShadowValues.filter(boxShadowHasVisiblePaint).length,
    gradientCount: raw.gradientCount,
    blurCount: raw.blurCount,
    sidebarWidthPx: raw.sidebarWidthPx,
    labelFontFamily: raw.labelFontFamily,
    labelCasing: raw.labelCasing,
    accentPixelRatio: raw.accentPixelRatio,
    textContrastRatio: raw.textContrastRatio,
    densityIndicator: raw.densityIndicator,
    selectorScopeLeaks: raw.selectorScopeLeaks,
  };
}

export function assertMonochromeInvariants(metrics: StyleMetrics): string[] {
  const violations: string[] = [];
  if (!metrics.fontReady) violations.push('fonts not ready at capture time');
  if (metrics.fontCount < 1) violations.push('no loaded fonts recorded');
  if (metrics.shadowCount !== STYLE_METRIC_ORACLE.shadowCount) {
    violations.push(`unexpected shadows: ${metrics.shadowCount}`);
  }
  if (metrics.gradientCount !== STYLE_METRIC_ORACLE.gradientCount) {
    violations.push(`unexpected gradients: ${metrics.gradientCount}`);
  }
  if (metrics.blurCount !== STYLE_METRIC_ORACLE.blurCount) {
    violations.push(`unexpected blur effects: ${metrics.blurCount}`);
  }
  if (
    metrics.colors.textColor !== '' &&
    (metrics.textContrastRatio === null ||
      metrics.textContrastRatio < STYLE_METRIC_ORACLE.minimumNormalTextContrast)
  ) {
    violations.push(`body text contrast below 4.5:1: ${metrics.textContrastRatio}`);
  }
  if (metrics.selectorScopeLeaks.length > 0) {
    violations.push(`selector scope leaks: ${metrics.selectorScopeLeaks.join(', ')}`);
  }
  return violations;
}

export function detectThemeLeakage(
  monochrome: StyleMetrics,
  otherTheme: StyleMetrics,
  themeName: string,
): string[] {
  const leaks: string[] = [];
  if (monochrome.theme === otherTheme.theme) {
    leaks.push(`${themeName}: comparison used the same theme`);
  }
  if (monochrome.colors.bodyBackground === otherTheme.colors.bodyBackground) {
    leaks.push(`${themeName}: body background matches MonoChrome`);
  }
  if (monochrome.colors.panelBackground === otherTheme.colors.panelBackground) {
    leaks.push(`${themeName}: panel background matches MonoChrome`);
  }
  return leaks;
}
