import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 5000 });
const candidates = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
  page,
  label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null),
  location: await page.evaluate(() => ({ origin: location.origin, pathname: location.pathname })).catch(() => null),
})));
const mains = candidates.filter(({ label, location }) =>
  label === 'main' && location?.origin === 'http://localhost:5173' && location.pathname === '/');
const receipt = {
  at: new Date().toISOString(),
  cdpEndpoint: 'http://127.0.0.1:9223',
  pageTargetCount: candidates.length,
  pageTargets: candidates.map(({ label, location }) => ({ label, ...location })),
  exactOfficialMainCount: mains.length,
  passed: mains.length === 1,
};
await writeFile('work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator/c1-main-target-recheck.json', `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exit(0);
