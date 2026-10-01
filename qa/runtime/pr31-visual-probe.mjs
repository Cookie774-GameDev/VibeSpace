import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } });
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('jarvis-ui') ?? '{"state":{},"version":5}');
    localStorage.setItem(
      'jarvis-ui',
      JSON.stringify({
        ...stored,
        version: 5,
        state: {
          ...stored.state,
          onboardingComplete: true,
          productTutorialStatus: 'pending',
          theme: 'warm',
          navOpen: true,
          inspectorOpen: false,
          ambient: false,
        },
      }),
    );
    localStorage.setItem(
      'vibespace-pet-settings',
      JSON.stringify({
        state: { enabled: false, overlayVisible: false, reducedMotion: true },
        version: 0,
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
  const skip = page.getByRole('button', { name: 'Skip and connect a model later' });
  if (await skip.isVisible()) {
    await skip.click();
    await page.waitForTimeout(2_000);
  }
  const output = 'qa/runtime/pr31-warm-refinement';
  await mkdir(output, { recursive: true });
  const capture = async (name) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: `${output}/${name}.png` });
  };
  await capture('chat');
  for (const [name, label, selector] of [
    ['kanban', 'Kanban', "[data-monochrome-route='kanban']"],
    ['schedule', 'Schedule', "[data-monochrome-route='schedule']"],
    ['benchmarks', 'Benchmarks', "[data-monochrome-route='benchmarks']"],
    ['history', 'History', "[data-monochrome-route='history']"],
    ['agents', 'Agents', "[data-monochrome-route='agents']"],
    ['skills', 'Skills', "[data-monochrome-route='skills']"],
    ['files', 'Files', "[data-monochrome-route='files']"],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).first().click({ force: true });
    await page.locator(selector).waitFor();
    await capture(name);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').filter({ hasText: 'Settings' }).waitFor();
  await capture('settings');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  for (const theme of ['jarvis', 'default', 'monochrome']) {
    await page.evaluate((nextTheme) => {
      const stored = JSON.parse(localStorage.getItem('jarvis-ui'));
      localStorage.setItem(
        'jarvis-ui',
        JSON.stringify({ ...stored, state: { ...stored.state, theme: nextTheme } }),
      );
    }, theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('banner', { name: 'Application header' }).waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).first().click({ force: true });
    await page.getByRole('heading', { name: 'Start a conversation' }).waitFor();
    await capture(`chat-${theme}`);
  }
  await page.setViewportSize({ width: 360, height: 420 });
  await page.goto('http://localhost:5173/?view=pet-mini-panel', {
    waitUntil: 'domcontentloaded',
  });
  const petPanel = page.getByRole('dialog', { name: 'Pet mini panel' });
  await petPanel.waitFor();
  const petWelcome = page.locator('[data-pet-chat-welcome="true"]');
  await petWelcome.waitFor();
  await capture('pet-panel-360x420-top');
  const petScroll = await petWelcome.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  await petWelcome.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await capture('pet-panel-360x420-bottom');
  await page.setViewportSize({ width: 520, height: 640 });
  await capture('pet-panel-520x640');
  console.log(
    JSON.stringify({
      body: (await page.locator('body').innerText()).slice(0, 400),
      storage: await page.evaluate(() => localStorage.getItem('jarvis-ui')),
      theme: await page.evaluate(() => document.documentElement.dataset.theme),
      petScroll,
    }),
  );
  await page.screenshot({ path: 'qa/runtime/pr31-visual-probe.png' });
} finally {
  await browser.close();
}
