'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const receipt = { at: new Date().toISOString(), readOnly: true, errors: [], console: [], requests: [] };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    page.on('pageerror', error => receipt.errors.push(String(error?.stack ?? error).slice(0, 2500)));
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning')
      receipt.console.push({ type: message.type(), text: message.text().slice(0, 1500) }); });
    page.on('requestfailed', request => receipt.requests.push({ url: request.url().slice(0, 200),
      failure: request.failure()?.errorText }));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    receipt.dom = await page.evaluate(() => ({ rootLength: document.querySelector('#root')?.outerHTML.length,
      bodyText: document.body?.innerText.slice(0, 1000), paneCount: document.querySelectorAll('[data-testid^="chat-pane-"]').length }));
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-render-error-capture-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, dom: receipt.dom, errors: receipt.errors.length,
      console: receipt.console.length, requests: receipt.requests.length, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
