'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const oldQuestion = 'qb_opencode_1lt9swl0v7q1dj';
const prompt = 'Use your native question tool to ask me one new harmless preference question about tea or coffee with exactly two choices. Wait for my response. Do not edit files or run commands.';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const guard = path.join(__dirname, 'codex-postfix-question-send-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, promptSha256: digest(prompt), providerSendAttempted: false, cancelAttempted: false, stage: 'attach' };
let browser;
async function state(page) {
  return page.evaluate(async id => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
    return {
      navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
      connection: `${chat?.connection?.id}:${chat?.connection?.modelId}`,
      backend: chat?.backend_affinity?.backend,
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
      draft: pane?.querySelector('[data-composer-input="true"]')?.value ?? null,
      stopVisible: Boolean(pane?.querySelector('button[aria-label="Stop current request"]')?.getBoundingClientRect().width),
      questions: rows.flatMap(row => (row.parts ?? []).filter(part => part.kind === 'question_block')
        .map(part => ({ messageId: row.id, id: part.block?.id ?? null,
          status: part.block?.status ?? null, requestId: part.block?.requestId ?? null }))),
      messages: rows.map(row => ({ id: row.id, role: row.role,
        text: (row.parts ?? []).filter(part => part.kind === 'text').map(part => part.text).join('\n') })),
    };
  }, chatId);
}
(async () => {
  if (fs.existsSync(guard)) throw new Error('once_only_guard_exists_reconcile_only');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
  if (mains.length !== 1) throw new Error('exact_official_main_required');
  const page = mains[0].page;
  const served = await page.request.get('http://localhost:5173/src/lib/ai/runtime.ts');
  if (!served.ok() || !(await served.text()).includes('block: { ...part.block, status: "cancelled" }'))
    throw new Error('fixed_runtime_source_not_served');
  const nav = page.getByTestId(`chat-nav-row-${chatId}`);
  await nav.click({ timeout: 15000 });
  const pane = page.locator(`[data-testid="chat-pane-${chatId}"]`);
  await pane.waitFor({ state: 'visible', timeout: 15000 });
  const before = await state(page);
  receipt.before = { ...before, messages: before.messages.map(row => ({ id: row.id, role: row.role })) };
  if (before.navCurrent !== 'page' || before.connection !== 'openai-codex:gpt-6-luna' ||
    before.backend !== 'codex' || before.stopVisible || before.draft !== '' ||
    !before.questions.some(q => q.id === oldQuestion && q.status === 'pending'))
    throw new Error('exact_existing_codex_fixture_required');
  const input = pane.locator('[data-composer-input="true"]');
  await input.fill(prompt, { timeout: 15000 });
  const send = pane.getByRole('button', { name: 'Send message', exact: true });
  if (!await send.isEnabled()) throw new Error('send_disabled');
  fs.writeFileSync(guard, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: digest(prompt), beforeIds: before.messages.map(row => row.id) }, null, 2) + '\n', { flag: 'wx' });
  receipt.providerSendAttempted = true;
  receipt.stage = 'sent';
  await send.click({ timeout: 15000, force: true });
  const deadline = Date.now() + 90000;
  let pending;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    pending = await state(page);
    if (pending.questions.some(q => q.id !== oldQuestion && q.status === 'pending') ||
      pending.status === 'Failed' || pending.status === 'Complete') break;
  }
  receipt.pending = pending && { status: pending.status, stopVisible: pending.stopVisible,
    questions: pending.questions, newMessages: pending.messages.filter(row =>
      !before.messages.some(old => old.id === row.id)) };
  const newQuestion = pending?.questions.find(q => q.id !== oldQuestion && q.status === 'pending');
  if (!newQuestion || !pending.stopVisible || !newQuestion.requestId?.startsWith('que_codex_'))
    throw new Error('new_native_codex_question_and_stop_not_both_visible');
  receipt.stage = 'cancel';
  receipt.cancelAttempted = true;
  await pane.getByRole('button', { name: 'Stop current request', exact: true }).click({ timeout: 15000 });
  const stopDeadline = Date.now() + 45000;
  let stopped;
  while (Date.now() < stopDeadline) {
    await page.waitForTimeout(500);
    stopped = await state(page);
    if (!stopped.stopVisible && stopped.status === 'Cancelled' &&
      stopped.questions.some(q => q.id === newQuestion.id && q.status === 'cancelled')) break;
  }
  receipt.after = stopped && { status: stopped.status, stopVisible: stopped.stopVisible,
    questions: stopped.questions, newMessages: stopped.messages.filter(row =>
      !before.messages.some(old => old.id === row.id)) };
  receipt.passed = receipt.after?.status === 'Cancelled' && !receipt.after.stopVisible &&
    receipt.after.questions.some(q => q.id === newQuestion.id && q.status === 'cancelled') &&
    receipt.after.newMessages.filter(row => row.role === 'user' && digest(row.text) === digest(prompt)).length === 1;
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-codex-postfix-cancel-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, pending: receipt.pending?.status,
      after: receipt.after?.status, cancelAttempted: receipt.cancelAttempted }));
    if (browser) await browser.close();
  });
