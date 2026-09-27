'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const receipt = { at: new Date().toISOString(), port: 9223, readOnly: true };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 60000 });
    const pages = browser.contexts().flatMap(c => c.pages());
    receipt.pages = [];
    for (const page of pages) {
      const item = { url: page.url(), closed: page.isClosed() };
      try {
        item.dom = await Promise.race([page.evaluate(() => ({
          label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
          readyState: document.readyState, title: document.title,
          bodyChildCount: document.body?.children.length ?? null,
          paneCount: document.querySelectorAll('[data-testid^="chat-pane-"]').length,
          currentPath: location.pathname + location.search,
        })), new Promise((_, reject) => setTimeout(() => reject(new Error('dom_evaluate_8s_timeout')), 8000))]);
      } catch (error) { item.domError = String(error?.message ?? error).slice(0, 300); }
      receipt.pages.push(item);
    }
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-c1-surface-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
