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
    const page = mains[0].page;
    receipt.dom = await page.evaluate(() => ({
      url: location.href, readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText.slice(0, 2000),
      rootHTML: document.querySelector('#root')?.outerHTML.slice(0, 4000),
      children: [...document.body.children].map(node => ({
        tag: node.tagName, id: node.id, className: node.className,
        text: node.textContent?.slice(0, 400) })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent?.slice(0, 300)),
    }));
    const screenshot = path.join(__dirname, `native-main-render-diagnostic-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, timeout: 15000 });
    receipt.screenshot = screenshot;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-main-render-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, screenshot: receipt.screenshot,
      rootLength: receipt.dom?.rootHTML?.length, bodyText: receipt.dom?.bodyText?.slice(0, 500),
      failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
