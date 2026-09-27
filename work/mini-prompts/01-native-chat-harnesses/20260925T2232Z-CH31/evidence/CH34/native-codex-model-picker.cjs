'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const id = 'cht_-zkkf_r46zzuxB3L';
(async () => {
  const receipt = { at: new Date().toISOString(), chatId: id, providerSend: false };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    const nav = page.getByTestId(`chat-nav-row-${id}`);
    if (await nav.getAttribute('aria-current') !== 'page') throw new Error('target_not_visible_active');
    const pane = page.locator(`[data-testid="chat-pane-${id}"]`);
    if (!await pane.isVisible()) throw new Error('target_pane_not_visible');
    receipt.before = { model: await pane.getByRole('button', { name: 'Choose model' }).textContent(),
      draft: await pane.locator('[data-composer-input="true"]').inputValue() };
    if (receipt.before.draft !== '') throw new Error('draft_not_empty');
    await pane.getByRole('button', { name: 'Choose model' }).click({ timeout: 15000 });
    const dialog = page.getByRole('dialog', { name: 'Choose AI model', exact: true });
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByRole('searchbox', { name: 'Search providers and models' }).fill('GPT-6 Luna');
    receipt.options = await dialog.locator('[role="listbox"]').first()
      .locator('[role="option"]').evaluateAll(nodes => nodes.map(node => ({
        value: node.getAttribute('data-value'), disabled: node.getAttribute('aria-disabled'),
        text: node.textContent?.trim().slice(0, 150) })));
    receipt.passed = receipt.options.some(x => x.value === 'openai-codex:gpt-6-luna' && x.disabled !== 'true');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-model-picker-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      options: receipt.options?.length, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
