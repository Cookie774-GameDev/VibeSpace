'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const id = 'cht_-zkkf_r46zzuxB3L';
const target = 'openai-codex:gpt-6-luna';
(async () => {
  const receipt = { at: new Date().toISOString(), chatId: id, target, providerSend: false };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    const nav = page.getByTestId(`chat-nav-row-${id}`);
    if (await nav.getAttribute('aria-current') !== 'page') throw new Error('target_not_active');
    const pane = page.locator(`[data-testid="chat-pane-${id}"]`);
    const input = pane.locator('[data-composer-input="true"]');
    if (!await pane.isVisible() || await input.inputValue() !== '') throw new Error('idle_target_required');
    receipt.before = await pane.getByRole('button', { name: 'Choose model' }).textContent();
    await pane.getByRole('button', { name: 'Choose model' }).click({ timeout: 15000 });
    const dialog = page.getByRole('dialog', { name: 'Choose AI model', exact: true });
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByRole('searchbox', { name: 'Search providers and models' }).fill('GPT-6 Luna');
    const list = dialog.locator('[role="listbox"]').first();
    const row = list.locator(`[role="option"][data-value="${target}"]`);
    if (await row.count() !== 1 || !await row.isVisible()) throw new Error('codex_luna_option_missing');
    await row.click({ timeout: 15000 });
    await page.waitForFunction(() => {
      const label = document.querySelector('[role="dialog"][aria-label="Choose AI model"] [role="listbox"]')
        ?.getAttribute('aria-label') ?? '';
      return label.endsWith(' route options') || label.endsWith(' effort options');
    }, null, { timeout: 15000 });
    receipt.stageLabel = await list.getAttribute('aria-label');
    if (receipt.stageLabel?.endsWith(' route options')) {
      const route = list.locator(`[role="option"][data-value="${target}"]`);
      await route.waitFor({ state: 'visible', timeout: 15000 });
      await route.click({ timeout: 15000 });
    }
    const effort = list.locator('[role="option"][data-effort-level="low"]');
    await effort.waitFor({ state: 'visible', timeout: 15000 });
    await effort.click({ timeout: 15000 });
    await dialog.waitFor({ state: 'hidden', timeout: 15000 });
    receipt.after = { model: await pane.getByRole('button', { name: 'Choose model' }).textContent(),
      draft: await input.inputValue(), navCurrent: await nav.getAttribute('aria-current') };
    receipt.passed = receipt.after.navCurrent === 'page' && receipt.after.draft === '' &&
      /codex/i.test(receipt.after.model ?? '') && /gpt-6-luna/i.test(receipt.after.model ?? '');
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-route-for-cancel-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      after: receipt.after, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
