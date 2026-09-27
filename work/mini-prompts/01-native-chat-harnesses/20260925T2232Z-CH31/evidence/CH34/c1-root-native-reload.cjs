const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const output = path.join(__dirname, `c1-root-native-reload-${Date.now()}.json`);
const receipt = { startedAt: new Date().toISOString(), chatId, stage: 'attach', providerSendAttempted: false };

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null),
  })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  receipt.before = await page.evaluate((id) => ({
    viewport: [innerWidth, innerHeight],
    status: [...document.querySelectorAll('[aria-label="Session status"]')].map((el) => el.textContent?.trim()),
    currentChat: document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')?.getAttribute('data-testid'),
    snippetKinds: [...document.querySelectorAll('[data-assistant-snippet]')].map((el) => el.getAttribute('data-assistant-snippet')),
    draft: document.querySelector('[data-composer-input="true"]')?.value ?? null,
    expectedChat: id,
  }), chatId);
  if (receipt.before.currentChat !== `chat-nav-row-${chatId}` ||
      receipt.before.draft !== '' ||
      !receipt.before.status.includes('Complete') ||
      receipt.before.snippetKinds.join(',') !== 'writing,typescript')
    throw new Error('pre_reload_guard_failed');
  receipt.stage = 'reload';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  receipt.stage = 'reconcile';
  await page.getByTestId(`chat-nav-row-${chatId}`).waitFor({ state: 'attached', timeout: 45_000 });
  await page.locator('[data-assistant-snippet="writing"]').waitFor({ state: 'attached', timeout: 45_000 });
  await page.locator('[data-assistant-snippet="typescript"]').waitFor({ state: 'attached', timeout: 45_000 });
  receipt.after = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight],
    navCurrent: document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')?.getAttribute('data-testid'),
    paneRect: (() => { const r = document.querySelector('[data-testid^="chat-pane-"]')?.getBoundingClientRect();
      return r ? { width: r.width, height: r.height } : null; })(),
    snippetRects: [...document.querySelectorAll('[data-assistant-snippet]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { kind: el.getAttribute('data-assistant-snippet'), width: r.width, height: r.height };
    }),
    status: [...document.querySelectorAll('[aria-label="Session status"]')].map((el) => el.textContent?.trim()),
    draft: document.querySelector('[data-composer-input="true"]')?.value ?? null,
  }));
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});
