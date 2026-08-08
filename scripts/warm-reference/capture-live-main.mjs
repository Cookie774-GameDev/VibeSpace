import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer, preview } from 'vite';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const appRoot = path.join(repositoryRoot, 'app');
const outputRoot = process.env.VIBESPACE_WARM_CAPTURE_OUTPUT_ROOT
  ? path.resolve(repositoryRoot, process.env.VIBESPACE_WARM_CAPTURE_OUTPUT_ROOT)
  : path.join(repositoryRoot, 'qa/warm-goal/pages');
let baseURL = process.env.VIBESPACE_WARM_CAPTURE_URL || 'http://127.0.0.1:5173';
let captureServer;
if (process.env.VIBESPACE_WARM_CAPTURE_DIST === '1') {
  captureServer = await preview({
    configFile: path.join(appRoot, 'vite.config.ts'),
    logLevel: 'silent',
    root: appRoot,
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
    root: appRoot,
  });
  const address = captureServer.httpServer.address();
  if (!address || typeof address === 'string') {
    await captureServer.close();
    throw new Error('Warm capture production preview did not expose a TCP address.');
  }
  baseURL = `http://127.0.0.1:${address.port}`;
} else if (process.env.VIBESPACE_WARM_CAPTURE_ISOLATED === '1') {
  process.chdir(appRoot);
  captureServer = await createServer({
    configFile: path.join(appRoot, 'vite.config.ts'),
    logLevel: 'silent',
    root: appRoot,
    server: {
      hmr: false,
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
  });
  await captureServer.listen();
  const address = captureServer.httpServer?.address();
  if (!address || typeof address === 'string') {
    await captureServer.close();
    throw new Error('Warm capture isolated server did not expose a TCP address.');
  }
  baseURL = `http://127.0.0.1:${address.port}`;
}
const viewportMatch = /^(?<width>\d+)x(?<height>\d+)$/u.exec(
  process.env.VIBESPACE_WARM_CAPTURE_VIEWPORT || '1672x941',
);
if (!viewportMatch?.groups) {
  throw new Error('VIBESPACE_WARM_CAPTURE_VIEWPORT must use WIDTHxHEIGHT, for example 1440x900.');
}
const captureViewport = {
  width: Number(viewportMatch.groups.width),
  height: Number(viewportMatch.groups.height),
};
if (captureViewport.width < 760 || captureViewport.height < 640) {
  throw new Error('Warm capture viewport must be at least 760x640.');
}
const canonicalViewport = captureViewport.width === 1672 && captureViewport.height === 941;

const UI_STATE = {
  state: {
    navOpen: true,
    inspectorOpen: false,
    activeChatId: null,
    activeAgentId: null,
    navSectionsCollapsed: {},
    chatMode: 'chat',
    theme: 'warm',
    density: 'cozy',
    appBrightness: 100,
    sakuraPetalsEnabled: false,
    sakuraPetalSpeed: 'normal',
    onboardingComplete: true,
    productTutorialStatus: 'pending',
    ambient: false,
    ambientThresholdMs: 300000,
    ambientDrone: false,
    ambientTrack: 'music-1',
    ambientVolume: 55,
    ambientAlwaysPlay: false,
    clockFormat: 'local',
    composerStt: true,
    defaultTerminalFontSize: 9,
    notificationMaster: false,
    doneNotifications: {
      jarvis: false,
      terminal: false,
      tasks: false,
      contextMaps: false,
      skills: false,
      connectors: false,
      reminders: false,
    },
    aiCompletionCue: false,
    notificationSound: true,
    notificationBadge: false,
    lastSeenWhatsNewVersion: null,
  },
  version: 5,
};

const PET_SETTINGS_STATE = {
  state: {
    enabled: false,
    overlayVisible: false,
    reducedMotion: true,
    showDiagnostics: false,
  },
  version: 0,
};

const routes = [
  ['chat', 'Chat'],
  ['canvas', 'Canvas'],
  ['terminals', 'Terminals'],
  ['kanban', 'Kanban'],
  ['scheduler', 'Schedule'],
  ['benchmarks', 'Benchmarks'],
  ['history', 'History'],
  ['agents', 'Agents'],
  ['skills', 'Skills'],
  ['tools', 'Tools'],
  ['files', 'Files'],
  ['context', 'Context'],
];

const routeReadySelector = {
  chat: "[data-vibespace-page='chat']",
  canvas: "[data-monochrome-route='canvas']",
  terminals: "[data-monochrome-route='terminal']",
  kanban: "[data-monochrome-route='kanban']",
  scheduler: "[data-monochrome-route='schedule']",
  benchmarks: "[data-monochrome-route='benchmarks']",
  history: "[data-monochrome-route='history']",
  agents: "[data-monochrome-route='agents']",
  skills: "[data-monochrome-route='skills']",
  tools: "[data-monochrome-route='tools']",
  files: "[data-monochrome-route='files']",
  context: "[data-monochrome-route='context']",
};
const settingsSections = [
  ['settings-general', 'General', 'general'],
  ['settings-plans', 'Plans', 'plans'],
  ['settings-providers', 'Providers', 'providers'],
  ['settings-ai-connectors', 'AI Connectors', 'connections'],
  ['settings-all-about-me', 'All About Me', 'allaboutme'],
  ['settings-plugins', 'Plugins', 'plugins'],
  ['settings-local-models', 'Local Models', 'localmodels'],
  ['settings-appearance', 'Appearance', 'appearance'],
  ['settings-voice', 'Voice', 'voice'],
  ['settings-speech-to-text', 'Speech to Text', 'composerstt'],
  ['settings-phone-voice', 'Phone & Voice', 'phone'],
  ['settings-ambient', 'Ambient', 'ambient'],
  ['settings-notifications', 'Notifications', 'notifications'],
  ['settings-telemetry', 'Telemetry', 'telemetry'],
  ['settings-accessibility', 'Accessibility', 'accessibility'],
  ['settings-hotkeys', 'Hotkeys', 'hotkeys'],
  ['settings-jarvis-actions', 'Jarvis Actions', 'jarvisactions'],
  ['settings-about', 'About', 'about'],
];
const requestedRoutes = new Set(
  (process.env.VIBESPACE_WARM_CAPTURE_ROUTES || routes.map(([slug]) => slug).join(','))
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean),
);

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'warm');
  await page.evaluate(async () => {
    await document.fonts.ready;
    const renderRelevantImages = [...document.images].filter((image) => {
      if (image.loading !== 'lazy') return true;
      const bounds = image.getBoundingClientRect();
      return bounds.bottom >= 0 && bounds.top <= innerHeight;
    });
    await Promise.race([
      Promise.all(renderRelevantImages.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(page, slug, suffix = 'primary') {
  const destination = canonicalViewport
    ? path.join(outputRoot, slug, 'final', `final-${suffix}.png`)
    : path.join(
        outputRoot,
        slug,
        'regression',
        `${captureViewport.width}x${captureViewport.height}-${suffix}.png`,
      );
  await mkdir(path.dirname(destination), { recursive: true });
  const audit = await page.evaluate(() => ({
    brokenImages: [...document.images].filter((image) => image.complete && !image.naturalWidth)
      .length,
    height: innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    theme: document.documentElement.dataset.theme,
    width: innerWidth,
  }));
  if (
    audit.theme !== 'warm' ||
    audit.width !== captureViewport.width ||
    audit.height !== captureViewport.height ||
    audit.brokenImages !== 0 ||
    audit.horizontalOverflow > 1
  ) {
    throw new Error(`${slug} failed capture audit: ${JSON.stringify(audit)}`);
  }
  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: destination,
  });
  console.log(`${slug}: ${JSON.stringify(audit)}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    viewport: captureViewport,
  });
  await context.addInitScript(
    ({ petSettingsState, uiState }) => {
      localStorage.setItem('jarvis-ui', JSON.stringify(uiState));
      localStorage.setItem('vibespace-pet-settings', JSON.stringify(petSettingsState));
    },
    { petSettingsState: PET_SETTINGS_STATE, uiState: UI_STATE },
  );
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('banner', { name: 'Application header' }).waitFor();

  for (const [slug, label] of routes) {
    if (!requestedRoutes.has(slug)) continue;
    const navButton = page.getByRole('button', { name: label, exact: true }).first();
    await navButton.click();
    await page.locator(routeReadySelector[slug]).waitFor();
    await settle(page);
    if (
      slug === 'chat' &&
      (await page.getByRole('heading', { name: 'Start a conversation' }).count()) === 0
    ) {
      const newChat = page.getByRole('button', { name: 'New chat', exact: true }).first();
      if (await newChat.isVisible()) {
        await newChat.click();
        await page.getByRole('heading', { name: 'Start a conversation' }).waitFor();
        await settle(page);
      }
    }
    await capture(page, slug);
    if (slug === 'context') {
      const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' });
      await inspectorToggle.click();
      await page.locator("[data-monochrome-surface='inspector']").waitFor();
      await settle(page);
      await capture(page, slug, 'inspector');
      await inspectorToggle.click();
      await page.locator("[data-monochrome-surface='inspector']").waitFor({ state: 'hidden' });
    }
  }

  if (requestedRoutes.has('model-foundry')) {
    await page.getByRole('button', { name: 'Open Build Your Own AI' }).click();
    await page.locator("[data-monochrome-route='model-foundry']").waitFor();
    await settle(page);
    await capture(page, 'model-foundry');
  }

  if (requestedRoutes.has('project-detail')) {
    await page
      .getByRole('button', { name: /^Open .+ settings$/u })
      .first()
      .click();
    await page.locator("[data-monochrome-route='project-detail']").waitFor();
    await settle(page);
    await capture(page, 'project-detail');
  }

  if (requestedRoutes.has('agent-detail')) {
    await page.getByLabel('Navigation').getByRole('button', { name: 'Coder', exact: true }).click();
    await page.locator("[data-monochrome-route='agent-detail']").waitFor();
    await settle(page);
    await capture(page, 'agent-detail');
  }

  const requestedAccountTabs = [
    ['account-profile', 'Profile'],
    ['account-usage', 'Usage'],
    ['account-billing', 'Billing'],
    ['account-pets', 'Pets'],
    ['account-support', 'Support'],
  ].filter(([slug]) => requestedRoutes.has(slug));
  if (
    requestedRoutes.has('account') ||
    requestedRoutes.has('pets') ||
    requestedAccountTabs.length > 0
  ) {
    await page.getByRole('button', { name: /^Open account(?: for .+)?$/ }).click();
    await page.getByRole('heading', { name: /^Hey,/ }).waitFor();
    await settle(page);
    if (requestedRoutes.has('account')) {
      await capture(page, 'account');
    }
    if (requestedRoutes.has('pets')) {
      await page.getByRole('tab', { name: 'Pets', exact: true }).click();
      await page
        .getByRole('tabpanel')
        .getByRole('heading', { name: 'Pets', exact: true })
        .waitFor();
      await settle(page);
      await capture(page, 'pets');
    }
    for (const [slug, label] of requestedAccountTabs) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await page.getByRole('tabpanel', { name: label, exact: true }).waitFor();
      await settle(page);
      await capture(page, slug);
    }
  }

  if (requestedRoutes.has('quick-launch')) {
    await page.getByRole('button', { name: 'Open quick launcher' }).click();
    const quickLaunchDialog = page.getByRole('dialog', { name: /Quick Launch/i });
    await quickLaunchDialog.waitFor();
    const addStarterSet = quickLaunchDialog.getByRole('button', { name: 'Add starter set' });
    if (await addStarterSet.isVisible()) {
      const youtubeLink = quickLaunchDialog.getByRole('button', { name: 'Launch YouTube' });
      let starterSetReady = false;
      for (let attempt = 0; attempt < 3 && !starterSetReady; attempt += 1) {
        await addStarterSet.click();
        starterSetReady = await youtubeLink
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
      }
      if (!starterSetReady) {
        throw new Error(
          'Quick Launch starter set did not become ready after three bounded attempts.',
        );
      }
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[role='dialog'] button")].some(
          (button) => button.textContent?.replace(/\s/gu, '') === 'All7',
        ),
      );
      const starterToast = page.getByRole('status').filter({ hasText: 'Starter links added' });
      const toastAppeared = await starterToast
        .waitFor({ state: 'visible', timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (toastAppeared) {
        await starterToast.getByRole('button', { name: 'Dismiss' }).click();
        await starterToast.waitFor({ state: 'hidden' });
      }
    }
    await settle(page);
    await page.evaluate(() => {
      for (const status of document.querySelectorAll("[role='status']")) {
        if (status.textContent?.includes('Starter links added')) {
          status.style.setProperty('display', 'none', 'important');
        }
      }
    });
    await capture(page, 'quick-launch');
    await quickLaunchDialog.getByRole('button', { name: 'Close' }).click();
  }

  const requestedSettingsSections = settingsSections.filter(([slug]) => requestedRoutes.has(slug));
  if (requestedRoutes.has('settings-root') || requestedSettingsSections.length > 0) {
    const settingsDialog = page.getByRole('dialog').filter({ hasText: 'Settings' });
    const ensureSettingsOpen = async () => {
      if (!(await settingsDialog.isVisible())) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await settingsDialog.waitFor();
      }
    };
    await ensureSettingsOpen();
    await settle(page);
    if (requestedRoutes.has('settings-root')) {
      await capture(page, 'settings-root');
    }
    for (const [slug, label, panelId] of requestedSettingsSections) {
      let captured = false;
      for (let attempt = 0; attempt < 3 && !captured; attempt += 1) {
        try {
          await ensureSettingsOpen();
          await settingsDialog.getByRole('tab', { name: label, exact: true }).click();
          await settingsDialog.locator(`#settings-panel-${panelId}`).waitFor({ state: 'visible' });
          await settle(page);
          await capture(page, slug);
          captured = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const recoverable =
            message.includes('Execution context was destroyed') ||
            message.includes('navigation') ||
            message.includes('Timeout');
          if (!recoverable || attempt === 2) throw error;
          await page.waitForLoadState('domcontentloaded');
          await page.getByRole('banner', { name: 'Application header' }).waitFor();
        }
      }
    }
  }
} finally {
  await browser.close();
  await captureServer?.close();
}
