import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ROUTES = [
  'route:chat',
  'route:files',
  'route:kanban',
  'route:schedule',
  'route:skills',
  'route:tools',
  'route:terminal',
] as const;

const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1672x941', width: 1672, height: 941 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
] as const;

const FIXTURE_HASHES = {
  chat: 'fd8950bf1a41f18797c3e4ea97ad25f1eac86ffda0862cc61e361bdea2a158c9',
  'terminal-workbench': 'd27d7b59bed7386b11335a93d8827deb13d251d6de216c3b5bb84bee9ba8bc2b',
} as const;

const routePath = (id: (typeof ROUTES)[number]): string =>
  id === 'route:terminal' ? '/terminal' : `/${id.slice('route:'.length)}`;

const fixtureForRoute = (
  id: (typeof ROUTES)[number],
): keyof typeof FIXTURE_HASHES =>
  id === 'route:files' || id === 'route:terminal'
    ? 'terminal-workbench'
    : 'chat';

async function prepareWarmFixture(page: Page, id: (typeof ROUTES)[number]): Promise<void> {
  const fixtureId = fixtureForRoute(id);
  const request = new URL(routePath(id), 'http://127.0.0.1');
  request.searchParams.set('monochrome-fixture', fixtureId);
  request.searchParams.set('monochrome-fixture-hash', FIXTURE_HASHES[fixtureId]);
  request.searchParams.set('monochrome-surface', id);
  request.searchParams.set('monochrome-theme', 'monochrome');
  request.searchParams.set('monochrome-origami-gate', 'false');

  await page.goto(`${request.pathname}${request.search}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-runtime-profile-handshake="ready"]').waitFor({ state: 'attached' });
  await page.locator('[data-monochrome-fixture-ready="true"]').waitFor({ state: 'attached' });
  const surface = page.locator(`[data-monochrome-surface-id="${id}"]`);
  await expect(surface).toHaveCount(1);
  await expect(surface).toBeVisible();
}

async function applyWarmTheme(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            document.documentElement.dataset.theme = 'warm';
            document.documentElement.dataset.themePreference = 'warm';
            await document.fonts.ready;
            await Promise.all(
              [...document.images].map((image) => image.decode().catch(() => undefined)),
            );
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
            return document.documentElement.dataset.theme;
          });
        } catch {
          return 'navigation-in-progress';
        }
      },
      { timeout: 15_000 },
    )
    .toBe('warm');
}

async function assertWarmSafety(page: Page): Promise<void> {
  let result:
    | {
        backgrounds: string[];
        focusOutlineStyle: string;
        focusOutlineWidth: string;
        horizontalOverflow: number;
        theme: string | undefined;
      }
    | undefined;
  for (let attempt = 0; attempt < 3 && !result; attempt += 1) {
    try {
      result = await page.evaluate(() => {
        const root = document.documentElement;
        const horizontalOverflow = root.scrollWidth - root.clientWidth;
        const backgrounds = [...document.querySelectorAll<HTMLElement>('*')]
          .map((element) => getComputedStyle(element).backgroundImage)
          .filter((value) => value !== 'none');
        const interactive = document.querySelector<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [role="button"]:not([aria-disabled="true"])',
        );
        interactive?.focus();
        const focus = interactive ? getComputedStyle(interactive) : null;
        return {
          backgrounds,
          focusOutlineStyle: focus?.outlineStyle ?? '',
          focusOutlineWidth: focus?.outlineWidth ?? '',
          horizontalOverflow,
          theme: root.dataset.theme,
        };
      });
    } catch (error) {
      if (!String(error).includes('Execution context was destroyed') || attempt === 2) throw error;
      await page.waitForLoadState('domcontentloaded');
      await applyWarmTheme(page);
    }
  }
  expect(result).toBeDefined();
  if (!result) return;

  expect(result.theme).toBe('warm');
  expect(result.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(result.backgrounds.join('\n')).not.toMatch(
    /right-flower|crane\.webp|bottom-mountains|origami-chat/iu,
  );
  expect(result.focusOutlineStyle).not.toBe('none');
  expect(Number.parseFloat(result.focusOutlineWidth)).toBeGreaterThanOrEqual(2);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: path.resolve('.artifacts/warm-theme', `${name}.png`),
  });
}

test.describe('Warm theme visual parity', () => {
  for (const id of ROUTES) {
    test(`${id} at 1672x941`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await prepareWarmFixture(page, id);
      await applyWarmTheme(page);
      await assertWarmSafety(page);
      await capture(page, `${id.replace(':', '-')}-1672x941`);
      expect(consoleErrors).toEqual([]);
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`route:chat responsive ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepareWarmFixture(page, 'route:chat');
      await applyWarmTheme(page);
      await assertWarmSafety(page);
      await capture(page, `route-chat-${viewport.name}`);
    });
  }
});
