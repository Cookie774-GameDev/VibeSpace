'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const id = 'cht_-zkkf_r46zzuxB3L';
(async () => {
  const receipt = { at: new Date().toISOString(), chatId: id, readOnly: true };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    receipt.state = await page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
      const parts = rows.flatMap(row => (row.parts ?? []).filter(part => part.kind === 'question_block')
        .map(part => ({ messageId: row.id, blockId: part.block?.id,
          status: part.block?.status, options: part.block?.questions?.map(q => q.options?.length),
          harness: part.harness ? { protocol: part.harness.protocol,
            requestId: part.harness.requestId, nativeRequestId: part.harness.nativeRequestId,
            sessionId: part.harness.sessionId, deadlineAt: part.harness.deadlineAt } : null })));
      return { navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
        status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
        stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')?.getBoundingClientRect().width),
        questions: parts,
        cardText: [...(pane?.querySelectorAll('[data-question-block], [aria-label*="question" i]') ?? [])]
          .map(node => node.textContent?.trim().slice(0, 350)).slice(-12),
        messages: rows.map(row => ({ id: row.id, role: row.role,
          partKinds: (row.parts ?? []).map(part => part.kind) })) };
    }, id);
    const screenshot = path.join(__dirname, `native-codex-cancel-reconcile-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, timeout: 15000 });
    receipt.screenshot = screenshot;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-cancel-reconcile-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, state: receipt.state && {
      status: receipt.state.status, questions: receipt.state.questions,
      stopVisible: receipt.state.stopVisible }, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
