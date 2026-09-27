'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_-zkkf_r46zzuxB3L';
const newQuestionId = 'qb_opencode_0klbb5d197liyf';
const guard = path.join(__dirname, 'codex-postfix-question-stop-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, newQuestionId, stopAttempted: false };
let browser;
async function state(page) {
  return page.evaluate(async id => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
    return {
      navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
      stopVisible: Boolean(pane?.querySelector('button[aria-label="Stop current request"]')?.getBoundingClientRect().width),
      questions: rows.flatMap(row => (row.parts ?? []).filter(part => part.kind === 'question_block')
        .map(part => ({ messageId: row.id, block: part.block }))),
      newUsers: rows.filter(row => row.role === 'user').map(row => ({ id: row.id,
        text: (row.parts ?? []).filter(part => part.kind === 'text').map(part => part.text).join('\n') })),
    };
  }, chatId);
}
(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
  if (mains.length !== 1) throw new Error('exact_official_main_required');
  const page = mains[0].page;
  receipt.before = await state(page);
  if (receipt.before.navCurrent !== 'page') throw new Error('different_chat_active');
  const question = receipt.before.questions.find(q => q.block?.id === newQuestionId);
  if (!question) throw new Error('new_question_missing');
  if (receipt.before.stopVisible && question.block.status === 'pending') {
    if (fs.existsSync(guard)) throw new Error('once_only_stop_guard_exists');
    fs.writeFileSync(guard, JSON.stringify({ at: new Date().toISOString(), chatId, newQuestionId }, null, 2) + '\n', { flag: 'wx' });
    receipt.stopAttempted = true;
    await page.locator(`[data-testid="chat-pane-${chatId}"]`).getByRole('button', { name: 'Stop current request', exact: true }).click({ timeout: 15000 });
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    receipt.after = await state(page);
    if (!receipt.after.stopVisible && receipt.after.status === 'Cancelled') break;
  }
  receipt.passed = receipt.after?.status === 'Cancelled' && !receipt.after.stopVisible &&
    receipt.after.questions.find(q => q.block?.id === newQuestionId)?.block.status === 'cancelled';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-codex-postfix-cancel-reconcile-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false, stopAttempted: receipt.stopAttempted,
      before: receipt.before?.status, after: receipt.after?.status, failure: receipt.failure }));
    if (browser) await browser.close();
  });
