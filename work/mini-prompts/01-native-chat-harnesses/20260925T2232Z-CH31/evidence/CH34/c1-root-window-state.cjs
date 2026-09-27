const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, `c1-root-window-state-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), stage: 'attach', actedOnWindow: false };
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  receipt.state = await mains[0].page.evaluate(async () => {
    const { getCurrentWindow } = await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');
    const current = getCurrentWindow();
    const [minimized, visible, inner, outer] = await Promise.all([
      current.isMinimized(), current.isVisible(), current.innerSize(), current.outerSize(),
    ]);
    return { label: current.label, minimized, visible,
      inner: { width: inner.width, height: inner.height },
      outer: { width: outer.width, height: outer.height },
      viewport: { width: innerWidth, height: innerHeight } };
  });
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});
