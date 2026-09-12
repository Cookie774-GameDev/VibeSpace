import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const output = 'qa/runtime/pr31-chat-themes';
await mkdir(output, { recursive: true });

async function createThemePage(theme, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((activeTheme) => {
    localStorage.setItem(
      'jarvis-ui',
      JSON.stringify({
        state: {
          onboardingComplete: true,
          productTutorialStatus: 'pending',
          theme: activeTheme,
          navOpen: true,
          inspectorOpen: false,
          ambient: false,
        },
        version: 5,
      }),
    );
    localStorage.setItem(
      'vibespace-pet-settings',
      JSON.stringify({
        state: { enabled: false, overlayVisible: false, reducedMotion: true },
        version: 0,
      }),
    );
  }, theme);
  const page = await context.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  const skip = page.getByRole('button', { name: 'Skip and connect a model later' });
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', { name: 'Chat', exact: true }).first().click({ force: true });
  await page.getByRole('heading', { name: 'Start a conversation' }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return { context, page };
}

try {
  for (const theme of ['default', 'monochrome', 'jarvis']) {
    for (const viewport of [
      { width: 860, height: 741 },
      { width: 1440, height: 900 },
    ]) {
      const { context, page } = await createThemePage(theme, viewport);
      const appliedTheme = await page.evaluate(() => document.documentElement.dataset.theme);
      const expectedDocumentTheme = theme === 'default' ? 'dark' : theme;
      if (appliedTheme !== expectedDocumentTheme) {
        throw new Error(
          `Expected ${expectedDocumentTheme}, received ${appliedTheme ?? 'unset'}`,
        );
      }
      await page.screenshot({
        path: `${output}/${theme}-${viewport.width}x${viewport.height}.png`,
      });
      await context.close();
    }
  }

  const { context, page } = await createThemePage('jarvis', { width: 320, height: 320 });
  await page.goto('http://localhost:5173/?view=pet-mini-panel', {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('dialog', { name: 'Pet mini panel' }).waitFor();
  const welcome = page.locator('[data-pet-chat-welcome="true"]');
  await welcome.waitFor();
  const topMetrics = await welcome.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  await page.screenshot({ path: `${output}/pet-jarvis-320x320-top.png` });
  await welcome.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(100);
  const bottomMetrics = await welcome.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  await page.screenshot({ path: `${output}/pet-jarvis-320x320-bottom.png` });
  if (topMetrics.scrollHeight <= topMetrics.clientHeight || bottomMetrics.scrollTop <= 0) {
    throw new Error(
      `Pet panel did not expose working vertical scroll: ${JSON.stringify({
        topMetrics,
        bottomMetrics,
      })}`,
    );
  }
  const activeChatId = await page
    .locator('[data-pet-chat-tab="true"][aria-selected="true"]')
    .getAttribute('data-chat-id');
  await page.evaluate((chatId) => {
    window.dispatchEvent(
      new CustomEvent('jarvis:token-boss:request', {
        detail: { chatId, providerId: 'codex', allowAudio: false },
      }),
    );
  }, activeChatId);
  const cinematic = page.getByRole('dialog', { name: /Token Boss/i });
  await cinematic.waitFor();
  await page.waitForTimeout(180);
  const cinematicBox = await cinematic.boundingBox();
  const threadBox = await page.locator('[data-pet-chat-thread-host="true"]').boundingBox();
  await page.screenshot({ path: `${output}/pet-jarvis-320x320-animation.png` });
  if (
    !cinematicBox ||
    !threadBox ||
    cinematicBox.width > threadBox.width + 1 ||
    cinematicBox.height > threadBox.height + 1
  ) {
    throw new Error(
      `Pet animation exceeded its scaled chat host: ${JSON.stringify({
        cinematicBox,
        threadBox,
      })}`,
    );
  }
  console.log(JSON.stringify({ topMetrics, bottomMetrics, cinematicBox, threadBox }));
  await context.close();
} finally {
  await browser.close();
}
