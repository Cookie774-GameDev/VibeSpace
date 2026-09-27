'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const id = 'cht_D8GQG9qj9GYHFoNZ';
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
    const chat = await page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const row = await db.chats.get(id);
      return row && { title: row.title, projectId: row.project_id, backend: row.backend_affinity?.backend };
    }, id);
    if (chat?.projectId !== 'prj_ybjv0yXnrGkGhAQY' || chat?.backend !== 'codex')
      throw new Error('exact_existing_codex_fixture_required');
    const nav = page.getByTestId(`chat-nav-row-${id}`);
    await nav.getByRole('button', { name: chat.title, exact: true }).click({ timeout: 15000 });
    await page.waitForFunction(id =>
      document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current') === 'page',
      id, { timeout: 20000 });
    const pane = page.locator(`[data-testid="chat-pane-${id}"]`);
    await pane.waitFor({ state: 'visible', timeout: 20000 });
    receipt.state = await page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const chat = await db.chats.get(id);
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
      return { connection: `${chat?.connection?.id}:${chat?.connection?.modelId}`,
        navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
        modelLabel: pane?.querySelector('button[aria-label="Choose model"]')?.textContent?.trim(),
        status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
        draft: pane?.querySelector('[data-composer-input="true"]')?.value ?? null,
        pendingQuestions: rows.flatMap(row => row.parts ?? []).filter(part =>
          part.kind === 'question_block' && part.block?.status === 'pending').length,
        userCount: rows.filter(row => row.role === 'user').length,
        ids: rows.map(row => row.id) };
    }, id);
    receipt.passed = receipt.state.connection === 'openai-codex:gpt-6-luna' &&
      receipt.state.navCurrent === 'page' && receipt.state.status === 'Complete' &&
      receipt.state.draft === '' && receipt.state.pendingQuestions === 0;
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-postfix-preflight-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      status: receipt.state?.status, model: receipt.state?.modelLabel,
      users: receipt.state?.userCount, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
