import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const root = 'work/benchmark-search-clarity-20260927-BS01';
const base = 'http://127.0.0.1:5180';
const report = { checks: {}, consoleErrors: [], pageErrors: [], requestFailures: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 300));
});
page.on('pageerror', (error) => report.pageErrors.push(error.message));
page.on('requestfailed', (request) =>
  report.requestFailures.push(`${request.url()}: ${request.failure()?.errorText}`),
);

try {
  await page.goto(`${base}/?route=benchmarks`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('button', { name: 'Get started' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Get started' }).click();
  for (let i = 0; i < 10; i++) {
    const open = page.getByRole('button', { name: 'Open Jarvis' });
    if (await open.isVisible().catch(() => false)) {
      await open.click();
      break;
    }
    const skip = page.getByRole('button', { name: 'Skip for now', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else if (await next.isVisible().catch(() => false)) await next.click();
    else await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(800);
  }
  const providerSkip = page.locator('button').filter({ hasText: 'Skip for now' }).last();
  if (await providerSkip.isVisible().catch(() => false)) await providerSkip.click();
  await page.getByRole('heading', { name: 'Overall ranking' }).waitFor({ timeout: 30_000 });
  const tourSkip = page.getByRole('button', { name: 'No thanks — skip' });
  if (await tourSkip.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) await tourSkip.click();
  await page.getByText(/25 of \d+ models shown/).waitFor({ timeout: 30_000 });
  const notesDismiss = page.getByRole('button', { name: 'Got it' });
  if (await notesDismiss.waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) {
    await notesDismiss.click();
    await notesDismiss.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  const scene = page.locator('[data-warm-decoration="benchmarks-scene"]');
  report.checks.scene = await scene.evaluate((node) => ({
    beforeImage: getComputedStyle(node, '::before').backgroundImage,
    imageClip: getComputedStyle(node.querySelector('img')).clipPath,
    overlay: getComputedStyle(node, '::after').backgroundImage,
  }));
  await page.screenshot({ path: `${root}/leaderboard-clear-desktop.png` });

  const search = page.getByRole('searchbox', { name: 'Search models' });
  await search.fill('grok');
  await page.getByText(/of \d+ models shown/).first().waitFor();
  report.checks.grokChartRows = await page.locator('[data-warm-surface="benchmarks-chart"] .grid').count();
  report.checks.grokVisible = await page.getByText(/Grok/i).first().isVisible();
  await page.screenshot({ path: `${root}/leaderboard-search-desktop.png` });

  await page.getByRole('button', { name: /^table$/i }).click();
  report.checks.grokTableRows = (await page.locator('tbody tr').count());
  report.checks.grokTableText = (await page.locator('tbody').innerText()).slice(0, 250);
  await page.getByLabel('Models', { exact: true }).selectOption('Anthropic');
  report.checks.noMatch = await page.getByText('No models match these filters.').isVisible();
  await page.getByLabel('Models', { exact: true }).selectOption('all');
  await page.getByRole('button', { name: 'Clear model search' }).click();
  report.checks.cleared = (await search.inputValue()) === '';
  report.checks.restoredRows = await page.locator('tbody tr').count();
  await page.screenshot({ path: `${root}/leaderboard-table-clear-desktop.png` });

  await page.getByRole('button', { name: /^chart$/i }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const navToggle = page.getByRole('button', { name: 'Toggle navigation' });
  if ((await navToggle.getAttribute('aria-pressed')) === 'true') await navToggle.click();
  report.checks.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  report.checks.mobileSearchVisible = await search.isVisible();
  await search.fill('grok');
  report.checks.mobileGrokVisible = await page.getByText(/Grok/i).first().isVisible();
  await page.screenshot({ path: `${root}/leaderboard-search-mobile.png`, fullPage: true });
} catch (error) {
  report.failure = String(error);
  await page.screenshot({ path: `${root}/browser-failure.png` }).catch(() => {});
} finally {
  writeFileSync(`${root}/browser-results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
