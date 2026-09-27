'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const receipt = { at: new Date().toISOString(), readOnly: true };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    receipt.dom = await mains[0].page.evaluate(() => ({
      readyState: document.readyState, bodyText: document.body?.innerText.slice(0, 400),
      paneCount: document.querySelectorAll('[data-testid^="chat-pane-"]').length,
      nav: performance.getEntriesByType('navigation').map(e => ({ name: e.name, duration: e.duration,
        loadEventEnd: e.loadEventEnd, domContentLoadedEventEnd: e.domContentLoadedEventEnd })),
      resources: performance.getEntriesByType('resource').slice(-120).map(e => ({
        name: e.name.replace(location.origin, ''), duration: Math.round(e.duration),
        start: Math.round(e.startTime), size: e.transferSize, responseEnd: Math.round(e.responseEnd) })),
    }));
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-main-module-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, paneCount: receipt.dom?.paneCount,
      bodyText: receipt.dom?.bodyText, resources: receipt.dom?.resources?.length,
      failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
