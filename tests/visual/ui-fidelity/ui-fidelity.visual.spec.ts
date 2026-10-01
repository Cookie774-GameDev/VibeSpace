import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE_HASHES = {
  chat: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
  'settings-appearance': '1531421802e9d827e011047c410dd29c6d7c459c03f2bdb9ad91154f8c5ab875',
  'terminal-workbench': 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
} as const;

type Case = {
  name: string;
  path: string;
  fixtureId: 'chat' | 'settings-appearance' | 'terminal-workbench';
  surfaceId: string;
  theme: 'monochrome' | 'origami';
  origamiGate?: boolean;
  applyTheme?: 'monochrome' | 'origami' | 'sakura' | 'warm';
  welcomeVariant?: 'boat' | 'lotus';
  sakuraPetalSpeed?: 'slow' | 'normal' | 'fast';
  expectedPetals?: number;
  reducedMotion?: boolean;
  viewport?: { width: number; height: number };
  terminalPaneCount?: number;
  activityState?: 'streaming' | 'idle';
  voiceState?: 'compact' | 'history';
};

const CASES: readonly Case[] = [
  {
    name: 'monochrome/settings-appearance',
    path: '/settings/appearance',
    fixtureId: 'settings-appearance',
    surfaceId: 'settings:appearance',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/chat',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/workbench',
    path: '/workbench',
    fixtureId: 'terminal-workbench',
    surfaceId: 'route:workbench',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/settings-accessibility',
    path: '/settings/accessibility',
    fixtureId: 'settings-appearance',
    surfaceId: 'settings:accessibility',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/settings-providers',
    path: '/settings/providers',
    fixtureId: 'settings-appearance',
    surfaceId: 'settings:providers',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/dropdown-open',
    path: '/chat?monochrome-state=dropdown-open',
    fixtureId: 'chat',
    surfaceId: 'state:dropdown-open',
    theme: 'monochrome',
  },
  {
    name: 'monochrome/tooltip-visible',
    path: '/chat?monochrome-state=tooltip-visible',
    fixtureId: 'chat',
    surfaceId: 'state:tooltip-visible',
    theme: 'monochrome',
  },
  {
    name: 'origami/chat-active',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'origami',
  },
  {
    name: 'origami/chat-boat',
    path: '/chat?monochrome-state=empty',
    fixtureId: 'chat',
    surfaceId: 'state:empty-state',
    theme: 'monochrome',
    applyTheme: 'origami',
    welcomeVariant: 'boat',
  },
  {
    name: 'origami/chat-lotus',
    path: '/chat?monochrome-state=empty',
    fixtureId: 'chat',
    surfaceId: 'state:empty-state',
    theme: 'monochrome',
    applyTheme: 'origami',
    welcomeVariant: 'lotus',
  },
  {
    name: 'origami/terminals',
    path: '/terminal',
    fixtureId: 'terminal-workbench',
    surfaceId: 'route:terminal',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'origami',
    terminalPaneCount: 10,
  },
  {
    name: 'origami/kanban',
    path: '/kanban',
    fixtureId: 'chat',
    surfaceId: 'route:kanban',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'origami',
  },
  {
    name: 'origami/voice-compact',
    path: '/chat?monochrome-state=overlay%3Avoice-modal-host',
    fixtureId: 'chat',
    surfaceId: 'overlay:voice-modal-host',
    theme: 'monochrome',
    applyTheme: 'origami',
    voiceState: 'compact',
  },
  {
    name: 'origami/voice-history',
    path: '/chat?monochrome-state=overlay%3Avoice-modal-host',
    fixtureId: 'chat',
    surfaceId: 'overlay:voice-modal-host',
    theme: 'monochrome',
    applyTheme: 'origami',
    voiceState: 'history',
  },
  {
    name: 'codex/empty-light',
    path: '/chat?monochrome-state=empty',
    fixtureId: 'chat',
    surfaceId: 'state:empty-state',
    theme: 'monochrome',
    applyTheme: 'origami',
    welcomeVariant: 'boat',
  },
  {
    name: 'codex/active-structured',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
  },
  {
    name: 'activity/working',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'origami',
    activityState: 'streaming',
  },
  {
    name: 'activity/idle',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'origami',
    activityState: 'idle',
  },
  {
    name: 'sakura/kanban',
    path: '/kanban',
    fixtureId: 'chat',
    surfaceId: 'route:kanban',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
  },
  {
    name: 'sakura/chat',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
  },
  {
    name: 'sakura/settings',
    path: '/settings/appearance',
    fixtureId: 'settings-appearance',
    surfaceId: 'settings:appearance',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
  },
  {
    name: 'sakura/petals-slow',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'slow',
    expectedPetals: 7,
  },
  {
    name: 'sakura/petals-fast',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'fast',
    expectedPetals: 12,
  },
  {
    name: 'sakura/reduced-motion',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'fast',
    expectedPetals: 0,
    reducedMotion: true,
  },
  {
    name: 'responsive/1920-sakura-kanban',
    path: '/kanban',
    fixtureId: 'chat',
    surfaceId: 'route:kanban',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'responsive/1920-warm-kanban',
    path: '/kanban',
    fixtureId: 'chat',
    surfaceId: 'route:kanban',
    theme: 'monochrome',
    applyTheme: 'warm',
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'responsive/1920-origami-chat',
    path: '/chat?monochrome-state=empty',
    fixtureId: 'chat',
    surfaceId: 'state:empty-state',
    theme: 'monochrome',
    applyTheme: 'origami',
    welcomeVariant: 'lotus',
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: 'responsive/1440-monochrome-settings',
    path: '/settings/appearance',
    fixtureId: 'settings-appearance',
    surfaceId: 'settings:appearance',
    theme: 'monochrome',
    viewport: { width: 1440, height: 900 },
  },
  {
    name: 'responsive/1440-codex-chat',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
    viewport: { width: 1440, height: 900 },
  },
  {
    name: 'responsive/1440-origami-terminals',
    path: '/terminal',
    fixtureId: 'terminal-workbench',
    surfaceId: 'route:terminal',
    theme: 'origami',
    origamiGate: true,
    applyTheme: 'origami',
    terminalPaneCount: 10,
    viewport: { width: 1440, height: 900 },
  },
  {
    name: 'responsive/1366-sakura-chat',
    path: '/chat',
    fixtureId: 'chat',
    surfaceId: 'route:chat',
    theme: 'monochrome',
    applyTheme: 'sakura',
    sakuraPetalSpeed: 'normal',
    expectedPetals: 9,
    viewport: { width: 1366, height: 768 },
  },
  {
    name: 'responsive/1366-warm-schedule',
    path: '/schedule',
    fixtureId: 'chat',
    surfaceId: 'route:schedule',
    theme: 'monochrome',
    applyTheme: 'warm',
    viewport: { width: 1366, height: 768 },
  },
  {
    name: 'responsive/1366-origami-chat',
    path: '/chat?monochrome-state=empty',
    fixtureId: 'chat',
    surfaceId: 'state:empty-state',
    theme: 'monochrome',
    applyTheme: 'origami',
    welcomeVariant: 'boat',
    viewport: { width: 1366, height: 768 },
  },
] as const;

async function capture(
  page: Page,
  name: string,
  animations: 'allow' | 'disabled' = 'disabled',
): Promise<void> {
  const target = path.resolve('.artifacts/ui-fidelity', `${name}.png`);
  await page.screenshot({
    animations,
    caret: 'hide',
    fullPage: false,
    path: target,
  });
}

async function prepareCase(page: Page, state: Case): Promise<void> {
  if (state.viewport) await page.setViewportSize(state.viewport);
  await page.emulateMedia({ reducedMotion: state.reducedMotion ? 'reduce' : 'no-preference' });
  if ((state.expectedPetals ?? 0) > 0) {
    await page.addInitScript(() => {
      const nativeRequestFrame = window.requestAnimationFrame.bind(window);
      let syntheticTimestamp = 0;
      window.requestAnimationFrame = (callback: FrameRequestCallback) =>
        nativeRequestFrame(() => {
          syntheticTimestamp += 16;
          callback(syntheticTimestamp);
        });
    });
  }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      await route.continue();
      return;
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });
  const request = new URL(state.path, 'http://127.0.0.1');
  request.searchParams.set('monochrome-fixture', state.fixtureId);
  request.searchParams.set('monochrome-fixture-hash', FIXTURE_HASHES[state.fixtureId]);
  request.searchParams.set('monochrome-surface', state.surfaceId);
  request.searchParams.set('monochrome-theme', state.theme);
  request.searchParams.set('monochrome-origami-gate', String(state.origamiGate ?? false));

  await page.goto(`${request.pathname}${request.search}`, { waitUntil: 'domcontentloaded' });
  const evidence = page.locator('[data-monochrome-fixture-ready="true"]').first();
  await page.locator('[data-runtime-profile-handshake="ready"]').waitFor({ state: 'attached' });
  await evidence.waitFor({ state: 'attached' });
  await expect(evidence).toHaveAttribute('data-fixture-hash', FIXTURE_HASHES[state.fixtureId]);
  await expect(evidence).toHaveAttribute('data-resolved-theme', state.theme);
  await expect(evidence).toHaveAttribute('data-fallback', 'false');
  const surface = page.locator(`[data-monochrome-surface-id="${state.surfaceId}"]`);
  await expect(surface).toHaveCount(1);
  await expect(surface).toBeVisible();
  if (state.applyTheme) {
    await page.evaluate(
      async ({ theme, petalSpeed }) => {
        const uiModule = await import('/src/stores/ui.ts');
        uiModule.useUIStore.getState().setTheme(theme);
        if (petalSpeed) uiModule.useUIStore.getState().setSakuraPetalSpeed(petalSpeed);
      },
      { theme: state.applyTheme, petalSpeed: state.sakuraPetalSpeed },
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', state.applyTheme);
  }
  if (state.expectedPetals !== undefined) {
    const backdrop = page.locator('[data-sakura-backdrop]');
    await expect(backdrop).toBeVisible();
    if (state.expectedPetals === 0) {
      await expect(page.locator('[data-sakura-petal]')).toHaveCount(0);
      await expect(backdrop).toHaveAttribute('data-sakura-rendering', 'static');
    } else {
      await expect(backdrop).toHaveAttribute('data-sakura-rendering', 'enhanced');
      await expect(page.locator('[data-sakura-petal]')).toHaveCount(state.expectedPetals);
      await expect(page.locator('[data-sakura-petals]')).toHaveAttribute(
        'data-sakura-speed',
        state.sakuraPetalSpeed ?? 'normal',
      );
    }
  }
  if (state.welcomeVariant) {
    await page.evaluate(
      async ({ variant, chatId }) => {
        const workspaceId = 'ui-fidelity-workspace';
        localStorage.setItem(
          'vibespace:origami-welcome:v1',
          JSON.stringify({
            assignments: [[chatId, variant]],
          }),
        );
        const authModule = await import('/src/stores/auth.ts');
        authModule.useAuthStore.setState({ workspaceId, projectId: null });
        const dbModule = await import('/src/lib/db/index.ts');
        const timestamp = Date.now();
        await dbModule.db.messages.where('chat_id').equals(chatId).delete();
        await dbModule.db.chats.put({
          id: chatId,
          workspace_id: workspaceId,
          title: `Origami ${variant} visual`,
          mode: 'chat',
          active_agent_ids: [],
          created_at: timestamp,
          updated_at: timestamp,
        });
        delete document.documentElement.dataset.monochromeChatFixture;
        delete document.documentElement.dataset.monochromeChatState;
        const uiModule = await import('/src/stores/ui.ts');
        uiModule.useUIStore.getState().setActiveChat(chatId);
      },
      {
        variant: state.welcomeVariant,
        chatId: `origami-visual-${state.welcomeVariant}`,
      },
    );
    const welcome = page.locator('[data-testid="origami-welcome-art"]');
    await expect(welcome).toBeVisible();
    await expect(welcome).toHaveAttribute('data-welcome-variant', state.welcomeVariant);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function prepareActivityState(page: Page, activityState: 'streaming' | 'idle') {
  const chatId = `ui-fidelity-activity-${activityState}`;
  const title = activityState === 'streaming' ? 'Live build stream' : 'Quiet workspace';
  await page.evaluate(
    async ({ chatId: targetChatId, title: targetTitle, activityState: targetState }) => {
      const workspaceId = 'ui-fidelity-workspace';
      const timestamp = Date.now();
      const authModule = await import('/src/stores/auth.ts');
      authModule.useAuthStore.setState({ workspaceId, projectId: null });
      const dbModule = await import('/src/lib/db/index.ts');
      await dbModule.db.chats.put({
        id: targetChatId,
        workspace_id: workspaceId,
        title: targetTitle,
        mode: 'chat',
        active_agent_ids: [],
        created_at: timestamp,
        updated_at: timestamp,
      });
      const taskRunModule = await import('/src/features/jarvis-runs/taskRunStore.ts');
      taskRunModule.useJarvisTaskRunStore.setState(
        targetState === 'streaming'
          ? {
              accountScope: 'ui-fidelity-account',
              runs: {
                'ui-fidelity-run': {
                  canonical: false,
                  runId: 'ui-fidelity-run',
                  chatId: targetChatId,
                  status: 'running',
                  goal: 'Build the active view',
                  userVisibleSummary: 'Streaming verified work',
                  progress: 52,
                  activeAgents: [],
                  activeTerminals: [],
                  updatedAt: new Date(timestamp).toISOString(),
                  cancellable: false,
                  transportRetryAvailable: false,
                },
              },
              activityByChat: {
                [targetChatId]: [
                  {
                    id: 'ui-fidelity-event',
                    chatId: targetChatId,
                    kind: 'agent',
                    status: 'running',
                    title: 'Streaming verified work',
                    ts: timestamp,
                  },
                ],
              },
            }
          : {
              accountScope: 'ui-fidelity-account',
              runs: {},
              activityByChat: {},
            },
      );
    },
    { chatId, title, activityState },
  );

  const row = page
    .locator('[data-nav-pane="true"]')
    .getByRole('button', { name: title, exact: true })
    .locator('..');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-testid="chat-activity-slot"]')).toHaveCount(1);
  const indicator = row.locator('[data-chat-activity-indicator]');
  if (activityState === 'streaming') {
    await expect(indicator).toHaveCount(1);
    await expect(indicator).toHaveAttribute('data-state', 'streaming');
  } else {
    await expect(indicator).toHaveCount(0);
  }
}

async function prepareVoiceState(page: Page, voiceState: 'compact' | 'history') {
  const chatId = 'ui-fidelity-voice-chat';
  await page.evaluate(
    async ({ chatId: targetChatId, includeHistory }) => {
      const workspaceId = 'ui-fidelity-workspace';
      const timestamp = Date.now();
      const authModule = await import('/src/stores/auth.ts');
      authModule.useAuthStore.setState({
        workspaceId,
        projectId: null,
        voiceAutoListenOnOpen: false,
      });
      const dbModule = await import('/src/lib/db/index.ts');
      await dbModule.db.chats.put({
        id: targetChatId,
        workspace_id: workspaceId,
        title: 'Voice fidelity session',
        mode: 'chat',
        active_agent_ids: [],
        created_at: timestamp,
        updated_at: timestamp,
      });
      if (includeHistory) {
        await dbModule.db.messages.bulkPut([
          {
            id: 'ui-fidelity-voice-user',
            chat_id: targetChatId,
            role: 'user',
            parts: [{ kind: 'text', text: 'Summarize the launch checklist.' }],
            created_at: timestamp,
            updated_at: timestamp,
          },
          {
            id: 'ui-fidelity-voice-assistant',
            chat_id: targetChatId,
            role: 'assistant',
            parts: [
              {
                kind: 'text',
                text: 'The visual pass is active, the responsive matrix is covered, and final verification remains.',
              },
            ],
            created_at: timestamp + 1,
            updated_at: timestamp + 1,
          },
        ]);
      }
      const voiceModule = await import('/src/features/voice/store.ts');
      voiceModule.useVoiceStore.setState({
        state: 'listening',
        errorMessage: null,
        partialTranscript: includeHistory ? 'Checking final evidence…' : '',
        session: Object.freeze({
          sessionId: 'ui-fidelity-voice-session',
          accountId: 'ui-fidelity-account',
          chatId: targetChatId,
          startedAt: timestamp,
        }),
      });
    },
    { chatId, includeHistory: voiceState === 'history' },
  );

  const panel = page.locator('[aria-label="Jarvis voice session"]');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-voice-appearance-state', 'listening');
  const disclosure = panel.getByRole('button', { name: /Command Center/u });
  if (voiceState === 'compact') {
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    return;
  }
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const transcript = panel.getByRole('log', { name: 'Voice session transcript' });
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('Summarize the launch checklist.');
  await expect(transcript).toContainText('The visual pass is active');
}

test.describe('UI master fidelity evidence', () => {
  for (const state of CASES) {
    test(state.name, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await prepareCase(page, state);
      if (state.terminalPaneCount) {
        const addPane = page.getByRole('button', { name: 'Add pane' });
        for (let index = 1; index < state.terminalPaneCount; index += 1) {
          await addPane.click();
        }
        await expect(
          page.getByText(
            new RegExp(
              `${state.terminalPaneCount}\\s*\\/\\s*${state.terminalPaneCount} panes`,
              'u',
            ),
          ),
        ).toBeVisible();
      }
      if (state.activityState) await prepareActivityState(page, state.activityState);
      if (state.voiceState) await prepareVoiceState(page, state.voiceState);
      if (state.name === 'sakura/settings') {
        const slow = page.getByRole('radio', { name: 'Slow' });
        const normal = page.getByRole('radio', { name: 'Normal' });
        const fast = page.getByRole('radio', { name: 'Fast' });
        await slow.scrollIntoViewIfNeeded();
        await slow.click();
        await expect(slow).toHaveAttribute('aria-checked', 'true');
        await expect(page.locator('[data-sakura-petal]')).toHaveCount(7);
        await fast.click();
        await expect(fast).toHaveAttribute('aria-checked', 'true');
        await expect(page.locator('[data-sakura-petal]')).toHaveCount(12);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const persisted = JSON.parse(localStorage.getItem('jarvis-ui') ?? '{}') as {
                state?: { sakuraPetalSpeed?: string };
              };
              return persisted.state?.sakuraPetalSpeed;
            }),
          )
          .toBe('fast');
        await normal.click();
        await expect(normal).toHaveAttribute('aria-checked', 'true');
        await expect(page.locator('[data-sakura-petal]')).toHaveCount(9);
      }
      if (state.name === 'sakura/petals-slow' || state.name === 'sakura/petals-fast') {
        const duration = await page
          .locator('[data-sakura-petal]')
          .first()
          .evaluate((element) => {
            return Number.parseFloat(getComputedStyle(element).animationDuration);
          });
        if (state.name.endsWith('slow')) expect(duration).toBeGreaterThan(24);
        else expect(duration).toBeLessThan(13);
        await page.waitForTimeout(3_000);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(consoleErrors).toEqual([]);
      if (state.surfaceId.startsWith('settings:')) {
        await expect(page.getByText('Settings', { exact: true }).first()).toBeVisible();
      } else if (state.surfaceId === 'route:workbench') {
        await expect(page.getByRole('main', { name: 'VibeSpace Workbench' })).toBeVisible();
      } else {
        await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
      }
      if (state.applyTheme) {
        await expect(page.locator('html')).toHaveAttribute('data-theme', state.applyTheme);
      }
      await capture(
        page,
        state.name,
        state.name === 'sakura/petals-slow' || state.name === 'sakura/petals-fast'
          ? 'allow'
          : 'disabled',
      );
    });
  }

  test('I-01 repeated theme switching keeps one coherent live surface', async ({ page }) => {
    await prepareCase(page, {
      name: 'interaction/theme-switching',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'monochrome',
    });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const sequence = [
      'monochrome',
      'sakura',
      'warm',
      'origami',
      'monochrome',
      'sakura',
      'warm',
      'origami',
    ] as const;

    for (const theme of sequence) {
      await page.evaluate(async (nextTheme) => {
        const uiModule = await import('/src/stores/ui.ts');
        uiModule.useUIStore.getState().setTheme(nextTheme);
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('[data-sakura-backdrop]')).toHaveCount(theme === 'sakura' ? 1 : 0);
      await expect(page.locator('[data-monochrome-surface-id="route:chat"]')).toHaveCount(1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  });

  test('I-02 settings, tooltip, popover, and dialog remain focused in every theme', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/overlays',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'monochrome',
    });

    for (const theme of ['monochrome', 'sakura', 'warm', 'origami'] as const) {
      await page.evaluate(async (nextTheme) => {
        const uiModule = await import('/src/stores/ui.ts');
        uiModule.useUIStore.getState().setTheme(nextTheme);
        uiModule.useUIStore.getState().setSettingsOpen(true);
      }, theme);
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
      expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(
        true,
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      const navigationToggle = page.getByRole('button', { name: 'Toggle navigation' });
      await navigationToggle.focus();
      const tooltipId = await navigationToggle.getAttribute('aria-describedby');
      expect(tooltipId).toBeTruthy();
      const tooltip = page.locator(`[id="${tooltipId}"]`);
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveAttribute('role', 'tooltip');

      const modelTrigger = page.getByRole('button', { name: 'Choose model' });
      await modelTrigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.jarvis-slash-dropdown')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.jarvis-slash-dropdown')).toHaveCount(0);
    }
  });

  test('I-03 a first local message removes each Origami welcome exactly once', async ({ page }) => {
    for (const variant of ['boat', 'lotus'] as const) {
      await prepareCase(page, {
        name: `interaction/first-message-${variant}`,
        path: '/chat?monochrome-state=empty',
        fixtureId: 'chat',
        surfaceId: 'state:empty-state',
        theme: 'monochrome',
        applyTheme: 'origami',
        welcomeVariant: variant,
      });
      const chatId = `origami-visual-${variant}`;
      const welcome = page.locator('[data-testid="origami-welcome-art"]');
      await expect(welcome).toHaveCount(1);
      await page.evaluate(
        async ({ chatId: targetChatId, text }) => {
          const dbModule = await import('/src/lib/db/index.ts');
          await dbModule.messageRepo.create({
            chat_id: targetChatId,
            role: 'user',
            parts: [{ kind: 'text', text }],
          });
        },
        { chatId, text: `First ${variant} message` },
      );
      await expect(welcome).toHaveCount(0);
      const userMessageCount = await page.evaluate(async (targetChatId) => {
        const dbModule = await import('/src/lib/db/index.ts');
        return dbModule.db.messages
          .where('chat_id')
          .equals(targetChatId)
          .filter((message) => message.role === 'user')
          .count();
      }, chatId);
      expect(userMessageCount).toBe(1);
    }
  });

  test('I-04 an empty Origami chat keeps its welcome across reload', async ({ page }) => {
    await prepareCase(page, {
      name: 'interaction/reload-stability',
      path: '/chat?monochrome-state=empty',
      fixtureId: 'chat',
      surfaceId: 'state:empty-state',
      theme: 'monochrome',
      applyTheme: 'origami',
    });
    await page.evaluate(async () => {
      const chatId = 'origami-visual-reload';
      const workspaceId = 'ui-fidelity-workspace';
      const timestamp = Date.now();
      const authModule = await import('/src/stores/auth.ts');
      authModule.useAuthStore.setState({ workspaceId, projectId: null });
      const dbModule = await import('/src/lib/db/index.ts');
      await dbModule.db.messages.where('chat_id').equals(chatId).delete();
      await dbModule.db.chats.put({
        id: chatId,
        workspace_id: workspaceId,
        title: 'Origami reload evidence',
        mode: 'chat',
        active_agent_ids: [],
        created_at: timestamp,
        updated_at: timestamp,
      });
      delete document.documentElement.dataset.monochromeChatFixture;
      delete document.documentElement.dataset.monochromeChatState;
      const uiModule = await import('/src/stores/ui.ts');
      uiModule.useUIStore.getState().setTheme('origami');
      uiModule.useUIStore.getState().setActiveChat(chatId);
    });
    const welcome = page.locator('[data-testid="origami-welcome-art"]');
    await expect(welcome).toBeVisible();
    const before = await page
      .locator('[data-testid="origami-welcome-art"]')
      .getAttribute('data-welcome-variant');
    expect(before).toMatch(/^(boat|lotus)$/u);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-runtime-profile-handshake="ready"]').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      const chatId = 'origami-visual-reload';
      const authModule = await import('/src/stores/auth.ts');
      authModule.useAuthStore.setState({
        workspaceId: 'ui-fidelity-workspace',
        projectId: null,
      });
      delete document.documentElement.dataset.monochromeChatFixture;
      delete document.documentElement.dataset.monochromeChatState;
      const uiModule = await import('/src/stores/ui.ts');
      uiModule.useUIStore.getState().setTheme('origami');
      uiModule.useUIStore.getState().setActiveChat(chatId);
    });
    await expect(welcome).toBeVisible();
    await expect(welcome).toHaveAttribute('data-welcome-variant', before ?? 'boat');
  });

  test('I-05 forty new local chats are unbiased and not assigned by alternation', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/welcome-distribution',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'monochrome',
    });
    const variants = await page.evaluate(async () => {
      localStorage.removeItem('vibespace:origami-welcome:v1');
      const welcomeModule = await import('/src/features/chat/origamiWelcome.ts');
      return Array.from({ length: 40 }, (_, index) =>
        welcomeModule.resolveOrigamiWelcomeVariant(`distribution-${index}`),
      );
    });
    const boatCount = variants.filter((variant) => variant === 'boat').length;
    const strictlyAlternating = variants.every(
      (variant, index) => index === 0 || variant !== variants[index - 1],
    );
    expect(boatCount).toBeGreaterThanOrEqual(8);
    expect(boatCount).toBeLessThanOrEqual(32);
    expect(strictlyAlternating).toBe(false);
    const stable = await page.evaluate(async (expected) => {
      const welcomeModule = await import('/src/features/chat/origamiWelcome.ts');
      return expected.every(
        (variant, index) =>
          welcomeModule.resolveOrigamiWelcomeVariant(`distribution-${index}`) === variant,
      );
    }, variants);
    expect(stable).toBe(true);
  });

  test('I-06 chat activity conveys queued, streaming, complete, and error states', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/activity-lifecycle',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'monochrome',
      applyTheme: 'origami',
    });
    await prepareActivityState(page, 'idle');
    const chatId = 'ui-fidelity-activity-idle';
    const row = page
      .locator('[data-nav-pane="true"]')
      .getByRole('button', { name: 'Quiet workspace', exact: true })
      .locator('..');
    const indicator = row.locator('[data-chat-activity-indicator]');

    const setSignal = async (
      status: 'waiting-for-input' | 'running' | 'completed' | 'failed',
      eventStatus?: 'running',
    ) => {
      await page.evaluate(
        async ({ chatId: targetChatId, status: targetStatus, eventStatus: targetEventStatus }) => {
          const timestamp = Date.now();
          const taskRunModule = await import('/src/features/jarvis-runs/taskRunStore.ts');
          taskRunModule.useJarvisTaskRunStore.setState({
            accountScope: 'ui-fidelity-account',
            runs: {
              'ui-fidelity-lifecycle-run': {
                canonical: false,
                runId: 'ui-fidelity-lifecycle-run',
                chatId: targetChatId,
                status: targetStatus,
                goal: 'Verify activity lifecycle',
                userVisibleSummary: targetStatus,
                progress: targetStatus === 'completed' ? 100 : 50,
                activeAgents: [],
                activeTerminals: [],
                updatedAt: new Date(timestamp).toISOString(),
                cancellable: false,
                transportRetryAvailable: false,
              },
            },
            activityByChat: targetEventStatus
              ? {
                  [targetChatId]: [
                    {
                      id: `event-${targetStatus}`,
                      chatId: targetChatId,
                      kind: 'agent',
                      status: targetEventStatus,
                      title: targetStatus,
                      ts: timestamp,
                    },
                  ],
                }
              : {},
          });
        },
        { chatId, status, eventStatus },
      );
    };

    await setSignal('waiting-for-input');
    await expect(indicator).toHaveAttribute('data-state', 'queued');
    await setSignal('running', 'running');
    await expect(indicator).toHaveAttribute('data-state', 'streaming');
    await setSignal('completed');
    await expect(indicator).toHaveAttribute('data-state', 'complete');
    await setSignal('failed');
    await expect(indicator).toHaveAttribute('data-state', 'error');
  });

  test('I-07 Sakura petals support persisted off, slow, normal, and fast states', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/petal-controls',
      path: '/settings/appearance',
      fixtureId: 'settings-appearance',
      surfaceId: 'settings:appearance',
      theme: 'monochrome',
      applyTheme: 'sakura',
      sakuraPetalSpeed: 'normal',
      expectedPetals: 9,
    });
    const toggle = page.getByRole('switch', { name: 'Falling petals' });
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await expect(page.locator('[data-sakura-petal]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const persisted = JSON.parse(localStorage.getItem('jarvis-ui') ?? '{}') as {
            state?: { sakuraPetalsEnabled?: boolean };
          };
          return persisted.state?.sakuraPetalsEnabled;
        }),
      )
      .toBe(false);
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    for (const [label, count] of [
      ['Slow', 7],
      ['Normal', 9],
      ['Fast', 12],
    ] as const) {
      const option = page.getByRole('radio', { name: label });
      await option.click();
      await expect(option).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('[data-sakura-petal]')).toHaveCount(count);
    }
  });

  test('I-08 reduced motion removes petals and simplifies live activity motion', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/reduced-motion',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'monochrome',
      applyTheme: 'sakura',
      sakuraPetalSpeed: 'fast',
      expectedPetals: 0,
      reducedMotion: true,
    });
    await prepareActivityState(page, 'streaming');
    await expect(page.locator('[data-sakura-petal]')).toHaveCount(0);
    await expect(page.locator('[data-sakura-backdrop]')).toHaveAttribute(
      'data-sakura-rendering',
      'static',
    );
    const bars = page.locator('[data-nav-pane="true"] [data-chat-activity-indicator] i').all();
    for (const bar of await bars) {
      expect(await bar.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    }
  });

  test('I-09 keyboard navigation reaches the composer and decorative art stays inert', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/keyboard',
      path: '/chat',
      fixtureId: 'chat',
      surfaceId: 'route:chat',
      theme: 'origami',
      origamiGate: true,
      applyTheme: 'origami',
    });
    const composer = page.getByPlaceholder(/Message Jarvis/u);
    for (let index = 0; index < 80; index += 1) {
      if (await composer.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(composer).toBeFocused();
    expect(await composer.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    await page.keyboard.type('Keyboard-only draft');
    await expect(composer).toHaveValue('Keyboard-only draft');
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.evaluate(
        () =>
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body &&
          document.activeElement.matches(':focus-visible'),
      ),
    ).toBe(true);
    const decor = page.locator('[data-testid="origami-chat-decor"]');
    await expect(decor).toHaveAttribute('aria-hidden', 'true');
    expect(await decor.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  });

  test('I-10 resizing preserves the active Origami chat and welcome without reload', async ({
    page,
  }) => {
    await prepareCase(page, {
      name: 'interaction/resize',
      path: '/chat?monochrome-state=empty',
      fixtureId: 'chat',
      surfaceId: 'state:empty-state',
      theme: 'monochrome',
      applyTheme: 'origami',
      welcomeVariant: 'boat',
    });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const welcome = page.locator('[data-testid="origami-welcome-art"]');
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(welcome).toBeVisible();
      await expect(welcome).toHaveAttribute('data-welcome-variant', 'boat');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    expect(
      await page.evaluate(async () => {
        const uiModule = await import('/src/stores/ui.ts');
        return uiModule.useUIStore.getState().activeChatId;
      }),
    ).toBe('origami-visual-boat');
  });
});
